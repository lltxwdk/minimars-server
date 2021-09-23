import moment from "moment";
import BookingModel, { BookingStatus } from "../models/Booking";
import PaymentModel, {
  PaymentGateway,
  flowGateways,
  Scene
} from "../models/Payment";
import CardModel, { CardStatus } from "../models/Card";
import { Types } from "mongoose";
import HttpError from "./HttpError";

export default async (
  dateInput?: string | Date,
  dateEndInput?: string | Date,
  store?: string,
  popBookingCardCoupon = false,
  scenes?: Scene[]
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
  if (
    popBookingCardCoupon &&
    moment(endOfDay).diff(startOfDay, "days", true) > 7
  ) {
    popBookingCardCoupon = false;
  }
  if (moment(endOfDay).diff(startOfDay, "months", true) > 1) {
    throw new HttpError(400, "受系统性能限制，实时计算最大查询范围为1个月");
  }
  const bookingsQuery = BookingModel.find({
    date: { $gte: dateStr, $lte: dateEndStr },
    status: {
      $in: [
        BookingStatus.IN_SERVICE,
        BookingStatus.FINISHED,
        BookingStatus.PENDING_REFUND
      ]
    }
  }).select(
    "type kidsCount adultsCount amountPaid amountPaidInBalance amountPaidInCard card coupon foodCoupons tableId items.quantity items.productCategory"
  );

  if (store) {
    bookingsQuery.where({ store });
  }

  const paymentsQuery = PaymentModel.find({
    createdAt: {
      $gte: startOfDay,
      $lte: endOfDay
    },
    paid: true
  }).select("amount amountDeposit assets debt revenue scene store gateway");

  if (store) {
    paymentsQuery.find({ store });
  }

  if (scenes) {
    paymentsQuery.find({ scene: { $in: scenes } });
  }

  const cardsQuery = CardModel.find({
    status: { $ne: CardStatus.CANCELED },
    createdAt: {
      $gte: startOfDay,
      $lte: endOfDay
    }
  });

  if (store) {
    cardsQuery.where({ sellAtStore: store });
  }

  bookingsQuery.setOptions({
    skipAutoPopulationPaths: [
      "customer",
      "store",
      "payments",
      "event",
      "gift",
      popBookingCardCoupon || "card",
      popBookingCardCoupon || "coupon",
      popBookingCardCoupon || "foodCoupons"
    ]
  });
  paymentsQuery.setOptions({ skipAutoPopulationPaths: ["customer"] });
  cardsQuery.setOptions({ skipAutoPopulationPaths: ["payments"] });

  const [bookings, payments, cards] = await Promise.all([
    bookingsQuery.exec(),
    paymentsQuery.exec(),
    cardsQuery.exec()
  ]);

  const customerTypes = [
    "card",
    "balance",
    "coupon",
    "guest",
    "contract",
    "other"
  ] as const;
  type CustomerType = typeof customerTypes[number];

  const customersByType = customerTypes.reduce((map, type) => {
    map[type as CustomerType] = {
      adultsCount: 0,
      kidsCount: 0,
      count: 0,
      amountPaid: 0
    };
    return map;
  }, {} as Record<CustomerType, { adultsCount: number; kidsCount: number; count: number; amountPaid: number }>);

  bookings
    .filter(b => b.type === Scene.PLAY)
    .forEach(booking => {
      let key: CustomerType;
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
      if (!customersByType[key]) {
        customersByType[key] = {
          adultsCount: 0,
          kidsCount: 0,
          count: 0,
          amountPaid: 0
        };
      }
      customersByType[key].adultsCount += booking.adultsCount || 0;
      customersByType[key].kidsCount += booking.kidsCount || 0;
      if (booking.kidsCount) {
        customersByType[key].count++;
      }
      customersByType[key].amountPaid = +(
        customersByType[key].amountPaid + (booking.amountPaid || 0)
      ).toFixed(10);
    });

  const customers = Object.keys(customersByType).reduce(
    (total, type) =>
      total +
      customersByType[type as CustomerType].adultsCount +
      customersByType[type as CustomerType].kidsCount,
    0
  );

  const bookingsCountByType = bookings.reduce((map, booking) => {
    if (!map[booking.type]) map[booking.type] = 0;
    if (booking.type === Scene.FOOD) {
      if (booking.card && !booking.tableId) return map;
    }
    map[booking.type]++;
    return map;
  }, {} as Record<Scene, number>);

  const assetsByGateways: { [gateway: string]: number } = payments
    .filter(p => p.gateway !== PaymentGateway.Coupon)
    .reduce((acc, payment) => {
      if (!acc[payment.gateway]) {
        acc[payment.gateway] = 0;
      }
      acc[payment.gateway] += payment.assets;
      return acc;
    }, {} as Record<PaymentGateway, number>);

  const assetsByScenes: { [scene: string]: number } = payments
    .filter(p => p.gateway !== PaymentGateway.Coupon)
    .reduce((acc, payment) => {
      if (!acc[payment.scene]) {
        acc[payment.scene] = 0;
      }
      acc[payment.scene] += payment.assets;
      return acc;
    }, {} as Record<Scene, number>);

  const assetsByStores: { [storeId: string]: number } = payments
    .filter(p => p.gateway !== PaymentGateway.Coupon)
    .reduce((acc, payment) => {
      if (!payment.store) return acc;
      const storeId = payment.store.toString();
      if (!acc[storeId]) {
        acc[storeId] = 0;
      }
      acc[storeId] += payment.assets;
      return acc;
    }, {} as Record<string, number>);

  const assets = Object.keys(assetsByScenes).reduce(
    (total, scene) => total + assetsByScenes[scene],
    0
  );

  const revenueByScenes: { [scene: string]: number } = payments.reduce(
    (acc, payment) => {
      if (!acc[payment.scene]) {
        acc[payment.scene] = 0;
      }
      acc[payment.scene] += payment.revenue;
      return acc;
    },
    {} as Record<Scene, number>
  );

  const revenue = Object.keys(revenueByScenes).reduce(
    (total, scene) => total + revenueByScenes[scene],
    0
  );

  const amountByScenes: { [scene: string]: number } = payments.reduce(
    (acc, payment) => {
      if (!acc[payment.scene]) {
        acc[payment.scene] = 0;
      }
      acc[payment.scene] += payment.amount;
      return acc;
    },
    {} as Record<Scene, number>
  );

  const couponsCount = bookings
    .filter(b => b.type === Scene.PLAY)
    .filter(b => b.coupon)
    .reduce((acc, booking) => {
      const coupon = booking.coupon;
      if (!coupon) return acc;
      let item = acc.find(c => c.name === coupon.title);
      if (!item) {
        item = {
          name: coupon.title,
          price: coupon.priceThirdPartyInternal || coupon.priceThirdParty,
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

  const cardsCount = bookings
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

  const balanceCount = bookings
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

  const cardsSellRenewTimesCount = cards.filter(c => c.isRenewTimes).length;
  const cardsSellFirstTimesCount = cards.filter(c => c.isFirstTimes).length;

  const foodSetsCount = bookings.reduce((total, booking) => {
    if (booking.items) {
      total += booking.items
        .filter(i => i.productCategory === "Mars超值套餐")
        .reduce((t, i) => t + i.quantity, 0);
    }
    if (booking.foodCoupons?.length) {
      total += booking.foodCoupons.filter(
        coupon => coupon.scene === Scene.FOOD && coupon.type === "set"
      ).length;
    }
    return total;
  }, 0);

  const dailyBookingsCondition: Record<string, any> = {
    date: { $gte: dateRangeStartStr, $lte: dateEndStr }
  };
  if (store) {
    dailyBookingsCondition.store = Types.ObjectId(store);
  }
  const dailyCustomers = await BookingModel.aggregate([
    { $match: dailyBookingsCondition },
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

  const dailyPaymentsCondition: Record<string, any> = {
    createdAt: { $gte: dateRangeStart, $lte: endOfDay },
    paid: true
  };

  if (store) {
    dailyPaymentsCondition.store = Types.ObjectId(store);
  }

  const dailyFlowAmount = await PaymentModel.aggregate([
    {
      $match: { ...dailyPaymentsCondition, gateway: { $in: flowGateways } }
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

  const dailyRevenue = await PaymentModel.aggregate([
    {
      $match: dailyPaymentsCondition
    },
    {
      $project: {
        revenue: 1,
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
        revenue: {
          $sum: "$revenue"
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
        revenue: 1
      }
    }
  ]);
  // console.log("[DEBUG] Chart calculated:", Date.now() - starts);

  return {
    bookingsCountByType,
    customersByType,
    customers,
    assetsByGateways,
    assetsByScenes,
    assetsByStores,
    assets,
    revenueByScenes,
    revenue,
    amountByScenes,
    couponsCount,
    cardsCount,
    balanceCount,
    cardsSellCount,
    cardsSellFirstTimesCount,
    cardsSellRenewTimesCount,
    foodSetsCount,
    dailyCustomers,
    dailyFlowAmount,
    dailyRevenue
  };
};
