import moment from "moment";
import BookingModel, { paidBookingStatus } from "../models/Booking";
import PaymentModel, {
  PaymentGateway,
  flowGateways,
  cardCouponGateways,
  Scene
} from "../models/Payment";
import { Store } from "../models/Store";
import { DocumentType } from "@typegoose/typegoose";
import CardModel from "../models/Card";

export default async (
  dateInput?: string | Date,
  dateEndInput?: string | Date,
  store?: DocumentType<Store>,
  popBookingCardCoupon = false
) => {
  // const starts: number = Date.now();
  // console.log("[DEBUG] Stats starts:", starts);
  const dateStr = moment(dateInput).format("YYYY-MM-DD"),
    dateEndStr = moment(dateEndInput || dateInput).format("YYYY-MM-DD"),
    startOfDay = moment(dateInput).startOf("day").toDate(),
    endOfDay = moment(dateEndInput || dateInput)
      .endOf("day")
      .toDate(),
    dateRangeStartStr = dateEndInput
      ? moment(dateInput).format("YYYY-MM-DD")
      : moment(dateInput).subtract(6, "days").format("YYYY-MM-DD"),
    dateRangeStart = dateEndInput
      ? moment(dateInput).toDate()
      : moment(dateInput).subtract(6, "days").startOf("day").toDate();
  const bookingsPaidQuery = BookingModel.find({
    date: { $gte: dateStr, $lte: dateEndStr },
    status: { $in: paidBookingStatus }
  }).select(
    "type kidsCount adultsCount amountPaid amountPaidInBalance amountPaidInCard card coupon"
  );

  if (store) {
    bookingsPaidQuery.find({ store });
  }

  const paymentsQuery = PaymentModel.find({
    createdAt: {
      $gte: startOfDay,
      $lte: endOfDay
    },
    paid: true
  }).select("amount amountDeposit scene store gateway");

  if (store) {
    paymentsQuery.find({ store });
  }

  const cardsQuery = CardModel.find({
    createdAt: {
      $gte: startOfDay,
      $lte: endOfDay
    }
  });

  if (store) {
    cardsQuery.find({ stores: store });
  }

  bookingsPaidQuery.setOptions({
    skipAutoPopulationPaths: [
      "customer",
      "store",
      "payments",
      "event",
      "gift",
      popBookingCardCoupon || "card",
      popBookingCardCoupon || "coupon"
    ]
  });
  paymentsQuery.setOptions({ skipAutoPopulationPaths: ["customer"] });

  const [bookingsPaid, payments, cards] = await Promise.all([
    bookingsPaidQuery.exec(),
    paymentsQuery.exec(),
    cardsQuery.exec()
  ]);

  const flowAmount = payments
    .filter(p => flowGateways.includes(p.gateway))
    .reduce((amount, p) => amount + p.amount, 0);

  const cardCouponAmount = payments
    .filter(p => cardCouponGateways.includes(p.gateway))
    .reduce((amount, p) => amount + (p.amountDeposit || p.amount), 0);

  const playAmount = payments
    .filter(p => p.scene === Scene.PLAY)
    .reduce((amount, p) => amount + (p.amountDeposit || p.amount), 0);

  const foodAmount = payments
    .filter(p => p.scene === Scene.FOOD)
    .reduce((amount, p) => amount + (p.amountDeposit || p.amount), 0);

  const mallAmount = payments
    .filter(p => p.scene === Scene.MALL)
    .reduce((amount, p) => amount + (p.amountDeposit || p.amount), 0);

  const customerCount = bookingsPaid
    .filter(b => b.type === Scene.PLAY)
    .reduce(
      (count, booking) =>
        count + (booking.adultsCount || 0) + (booking.kidsCount || 0),
      0
    );

  const customersByType = bookingsPaid
    .filter(b => b.type === Scene.PLAY)
    .reduce(
      (acc, booking) => {
        let key: "card" | "balance" | "coupon" | "guest" | "contract" | "other";
        if (booking.coupon) {
          key = "coupon";
        } else if (booking.amountPaidInBalance) {
          key = "balance";
        } else if (booking.card) {
          if (booking.card.isContract) {
            key = "contract";
          } else {
            key = "card";
          }
        } else if (!booking.card && !booking.coupon) {
          key = "guest";
        } else {
          key = "other";
        }
        acc[key].adultsCount += booking.adultsCount || 0;
        acc[key].kidsCount += booking.kidsCount || 0;

        return acc;
      },
      {
        card: { adultsCount: 0, kidsCount: 0 },
        coupon: { adultsCount: 0, kidsCount: 0 },
        guest: { adultsCount: 0, kidsCount: 0 },
        balance: { adultsCount: 0, kidsCount: 0 },
        contract: { adultsCount: 0, kidsCount: 0 },
        other: { adultsCount: 0, kidsCount: 0 }
      }
    );

  const bookingsCountByType = bookingsPaid.reduce((map, booking) => {
    if (!map[booking.type]) map[booking.type] = 0;
    map[booking.type]++;
    return map;
  }, {} as Record<Scene, number>);

  const flowAmountByGateways: { [gateway: string]: number } = payments
    .filter(p => flowGateways.includes(p.gateway))
    .reduce((acc, payment) => {
      if (!acc[payment.gateway]) {
        acc[payment.gateway] = 0;
      }
      acc[payment.gateway] += payment.amount;
      return acc;
    }, {} as Record<PaymentGateway, number>);

  const flowAmountByScenes: { [gateway: string]: number } = payments
    .filter(p => flowGateways.includes(p.gateway))
    .reduce((acc, payment) => {
      if (!acc[payment.scene]) {
        acc[payment.scene] = 0;
      }
      acc[payment.scene] += payment.amount;
      return acc;
    }, {} as Record<Scene, number>);

  const flowAmountByStores: { [storeId: string]: number } = payments
    .filter(p => flowGateways.includes(p.gateway))
    .reduce((acc, payment) => {
      if (!payment.store) return acc;
      const storeId = payment.store.toString();
      if (!acc[storeId]) {
        acc[storeId] = 0;
      }
      acc[storeId] += payment.amount;
      return acc;
    }, {} as Record<string, number>);

  const couponsCount = bookingsPaid
    .filter(b => b.type === Scene.PLAY)
    .filter(b => b.coupon)
    .reduce((acc, booking) => {
      const coupon = booking.coupon;
      if (!coupon) return acc;
      let item = acc.find(c => c.name === coupon.title);
      if (!item) {
        item = {
          name: coupon.title,
          price: coupon.priceThirdParty,
          kidsCount: 0,
          adultsCount: 0,
          amount: 0,
          kidsPerCoupon: coupon.kidsCount
        };
        acc.push(item);
      }
      item.adultsCount += booking.adultsCount || 0;
      item.kidsCount += booking.kidsCount || 0;
      return acc;
    }, [] as { name: string; price: number; kidsCount: number; adultsCount: number; amount: number; kidsPerCoupon: number }[])
    .map(item => {
      if (item.kidsPerCoupon) {
        item.amount = (item.price * item.kidsCount) / item.kidsPerCoupon;
      } else {
        item.amount = item.price * item.adultsCount;
      }
      // couponsCount kidsCount is used as coupon count
      item.kidsCount = item.kidsCount / item.kidsPerCoupon;
      return item;
    });

  const cardsSellCount = cards.reduce((acc, card) => {
    let item = acc.find(i => i.name === card.title);

    if (!item) {
      item = {
        name: card.title,
        type: card.type,
        count: 0,
        isContract: !!card.isContract,
        amount: 0
      };
      if (card.times !== undefined) {
        item.times = 0;
      }
      if (card.balance !== undefined) {
        item.balance = 0;
      }

      acc.push(item);
    }

    item.count++;
    item.amount = +(item.amount + card.price).toFixed(10);
    if (item.times !== undefined && card.times !== undefined) {
      item.times += card.times;
    }
    if (item.balance !== undefined && card.balance !== undefined) {
      item.balance = +(item.balance + card.balance).toFixed(10);
    }
    return acc;
  }, [] as { name: string; type: string; count: number; isContract: boolean; times?: number; balance?: number; amount: number }[]);

  const cardsCount = bookingsPaid
    .filter(b => b.card)
    .reduce((acc, booking) => {
      const card = booking.card;
      if (!card) return acc;

      let item = acc.find(i => i.name === card.title);

      if (!item) {
        item = {
          name: card.title,
          count: 0,
          isContract: card.isContract || false,
          adultsCount: 0,
          kidsCount: 0,
          amount: 0
        };
        acc.push(item);
      }

      item.adultsCount += booking.adultsCount || 0;
      item.kidsCount += booking.kidsCount || 1;
      item.amount +=
        (booking.amountPaidInCard || 0) + (booking.amountPaidInDeposit || 0);
      return acc;
    }, [] as { name: string; count: number; isContract: boolean; adultsCount: number; kidsCount: number; amount: number }[]);

  const balanceCount = bookingsPaid
    .filter(b => b.type === Scene.PLAY)
    .filter(b => b.amountPaidInBalance)
    .reduce(
      (acc, booking) => {
        acc.adultsCount += booking.adultsCount || 0;
        acc.kidsCount += booking.kidsCount || 0;
        return acc;
      },
      {
        name: "账户余额",
        adultsCount: 0,
        kidsCount: 0,
        amount: 0
      }
    );

  balanceCount.amount = payments
    .filter(p => p.gateway === PaymentGateway.Balance)
    .reduce((acc, p) => acc + (p.amountDeposit || p.amount), 0);
  // console.log("[DEBUG] Groups calculated:", Date.now() - starts);

  const dailyCustomers = await BookingModel.aggregate([
    { $match: { date: { $gte: dateRangeStartStr, $lte: dateEndStr } } },
    {
      $project: {
        adultsCount: 1,
        kidsCount: 1,
        date: {
          $dateToParts: {
            date: {
              $dateFromString: {
                dateString: "$date",
                timezone: "Asia/Shanghai"
              }
            },
            timezone: "Asia/Shanghai"
          }
        }
      }
    },
    {
      $group: {
        _id: {
          y: "$date.year",
          m: "$date.month",
          d: "$date.day"
        },
        adultsCount: {
          $sum: "$adultsCount"
        },
        kidsCount: {
          $sum: "$kidsCount"
        }
      }
    },
    {
      $sort: { _id: 1 }
    },
    {
      $project: {
        _id: 0,
        day: {
          $dayOfWeek: {
            date: {
              $dateFromParts: {
                year: "$_id.y",
                month: "$_id.m",
                day: "$_id.d",
                timezone: "Asia/Shanghai"
              }
            }
          }
        },
        adultsCount: 1,
        kidsCount: 1
      }
    }
  ]);

  const dailyFlowAmount = await PaymentModel.aggregate([
    {
      $match: {
        createdAt: { $gte: dateRangeStart, $lte: endOfDay },
        paid: true,
        gateway: { $in: flowGateways }
      }
    },
    {
      $project: {
        amountDeposit: 1,
        amount: 1,
        date: {
          $dateToParts: {
            date: "$createdAt",
            timezone: "Asia/Shanghai"
          }
        }
      }
    },
    {
      $group: {
        _id: {
          y: "$date.year",
          m: "$date.month",
          d: "$date.day"
        },
        amount: {
          $sum: { $cond: ["$amountDeposit", "$amountDeposit", "$amount"] }
        }
      }
    },
    {
      $sort: { _id: 1 }
    },
    {
      $project: {
        _id: 0,
        day: {
          $dayOfWeek: {
            date: {
              $dateFromParts: {
                year: "$_id.y",
                month: "$_id.m",
                day: "$_id.d",
                timezone: "Asia/Shanghai"
              }
            }
          }
        },
        amount: 1
      }
    }
  ]);

  const dailyCardCouponPayment = await PaymentModel.aggregate([
    {
      $match: {
        createdAt: { $gte: dateRangeStart, $lte: endOfDay },
        paid: true,
        gateway: { $in: cardCouponGateways }
      }
    },
    {
      $project: {
        amount: 1,
        date: {
          $dateToParts: {
            date: "$createdAt",
            timezone: "Asia/Shanghai"
          }
        }
      }
    },
    {
      $group: {
        _id: {
          y: "$date.year",
          m: "$date.month",
          d: "$date.day"
        },
        amount: {
          $sum: "$amount"
        }
      }
    },
    {
      $sort: { _id: 1 }
    },
    {
      $project: {
        _id: 0,
        day: {
          $dayOfWeek: {
            date: {
              $dateFromParts: {
                year: "$_id.y",
                month: "$_id.m",
                day: "$_id.d",
                timezone: "Asia/Shanghai"
              }
            }
          }
        },
        amount: 1
      }
    }
  ]);
  // console.log("[DEBUG] Chart calculated:", Date.now() - starts);

  return {
    flowAmount,
    cardCouponAmount,
    playAmount,
    foodAmount,
    mallAmount,
    customerCount,
    bookingsCountByType,
    flowAmountByGateways,
    flowAmountByScenes,
    flowAmountByStores,
    couponsCount,
    cardsSellCount,
    cardsCount,
    balanceCount,
    customersByType,
    dailyCustomers,
    dailyFlowAmount,
    dailyCardCouponPayment
  };
};
