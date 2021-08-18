import Agenda from "agenda";
import moment from "moment";
import axios from "axios";
import { MongoClient } from "mongodb";
import { DocumentType } from "@typegoose/typegoose";
import Booking, { BookingStatus } from "../models/Booking";
import CardModel, { Card, CardStatus } from "../models/Card";
import Gift from "../models/Gift";
import CardType from "../models/CardType";
import Event from "../models/Event";
import Post from "../models/Post";
import Store, { storeMap } from "../models/Store";
import UserModel, { User } from "../models/User";
import configModel, { Config } from "../models/Config";
import CardTypeModel from "../models/CardType";
import StoreModel from "../models/Store";
import paymentModel, {
  Payment,
  PaymentGateway,
  Scene
} from "../models/Payment";
import { saveContentImages, sleep } from "./helper";
import { getMpUserOpenids, getQrcode, getUsersInfo } from "./wechat";
import Pospal from "./pospal";
import BookingModel from "../models/Booking";
import { syncUserPoints } from "./youzan";
import PaymentModel from "../models/Payment";

const mongodbUrl = process.env.MONGODB_URL || "";

const agenda: Agenda = new Agenda();

export const initAgenda = async () => {
  const client = new MongoClient(mongodbUrl, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });

  await client.connect();

  agenda.mongo(client.db());

  agenda.define("cancel expired pending bookings", async (job, done) => {
    const bookings = await Booking.find({
      status: BookingStatus.PENDING,
      createdAt: {
        $lt: moment().subtract(10, "minutes").toDate()
      }
    });

    if (bookings.length) {
      console.log(`[CRO] Cancel expired pending bookings...`);
    }

    for (const booking of bookings) {
      await booking.cancel(true);
    }

    done();
  });

  agenda.define("cancel expired booked bookings", async (job, done) => {
    const bookings = await Booking.find({
      status: BookingStatus.BOOKED,
      date: {
        $lt: moment().format("YYYY-MM-DD")
      }
    });

    if (bookings.length) {
      console.log(`[CRO] Cancel expired booked bookings...`);
    }

    for (const booking of bookings) {
      await booking.cancel();
    }

    done();
  });

  agenda.define("finish in_service bookings", async (job, done) => {
    const bookings = await Booking.find({
      status: BookingStatus.IN_SERVICE,
      date: {
        $lt: moment().format("YYYY-MM-DD")
      }
    });

    if (bookings.length) {
      console.log(`[CRO] Finish previous in-service bookings...`);
    }

    for (const booking of bookings) {
      await booking.finish();
    }

    done();
  });

  agenda.define("cancel expired pending cards", async (job, done) => {
    const cards = await CardModel.find({
      status: CardStatus.PENDING,
      createdAt: {
        $lt: moment().subtract(10, "minutes").toDate()
      }
    });

    if (cards.length) {
      console.log(`[CRO] Cancel expired pending cards...`);
    }

    for (const card of cards) {
      card.status = CardStatus.CANCELED;
      await card.save();
    }

    done();
  });

  agenda.define("save image from content", async (job, done) => {
    console.log(`[CRO] Running '${job.attrs.name}'...`);
    const cardTypes = await CardType.find();
    const events = await Event.find();
    const gifts = await Gift.find();
    const posts = await Post.find();
    const stores = await Store.find();
    for (const documents of [cardTypes, events, gifts, posts, stores]) {
      for (const document of documents) {
        if (!document.content) continue;
        document.content = saveContentImages(document.content);
        // @ts-ignore
        document.save();
      }
    }
    console.log(`[CRO] Finished '${job.attrs.name}'.`);
    done();
  });

  agenda.define("set expired cards", async (job, done) => {
    console.log(`[CRO] Running '${job.attrs.name}'...`);
    await CardModel.updateMany(
      { type: { $in: ["coupon", "period"] }, expiresAt: { $lt: new Date() } },
      { $set: { status: CardStatus.EXPIRED } }
    );
    console.log(`[CRO] Finished '${job.attrs.name}'.`);
    done();
  });

  agenda.define("check balance reward cards", async (job, done) => {
    // TODO: this is memory killer and has been disabled for now
    console.log(`[CRO] Running '${job.attrs.name}'...`);
    const cards = await CardModel.find({
      status: { $in: [CardStatus.ACTIVATED, CardStatus.VALID] }
    });
    const users = await UserModel.find({
      _id: { $in: cards.map(c => c.customer) }
    });
    const userMap: Map<
      string,
      DocumentType<User> & { cards: DocumentType<Card>[] }
    > = new Map();
    users.forEach(u => {
      userMap.set(u.id, Object.assign(u, { cards: [] }));
    });
    cards.forEach(c => {
      const u = userMap.get(c.customer?.toString() || "");
      if (!u) return;
      u.cards.push(c);
    });
    const cardTypes = await CardTypeModel.find({
      rewardCardTypes: { $exists: true },
      type: "balance"
    });
    for (const cardType of cardTypes) {
      const rewardCardTypes = await CardTypeModel.find({
        slug: { $in: cardType.rewardCardTypes?.split(" ") }
      });

      for (const [, user] of userMap) {
        const shouldRewardCount = user.cards.filter(
          c => c.slug === cardType.slug
        ).length;
        for (const rewardCardType of rewardCardTypes) {
          const fixRewardCount =
            shouldRewardCount -
            user.cards.filter(c => c.slug === rewardCardType.slug).length;
          for (let i = 0; i < fixRewardCount; i++) {
            console.log(
              `[CRO] User ${user.id} missing reward ${rewardCardType.slug} from ${cardType.slug}.`
            );
            const rewardedCard = rewardCardType.issue(user);
            rewardedCard.paymentSuccess();
            try {
              await rewardedCard.save();
            } catch (e) {
              console.error(e.message);
            }
          }
        }
      }
    }
    console.log(`[CRO] Finished '${job.attrs.name}'.`);
    done();
  });

  agenda.define("update holidays", async (job, done) => {
    console.log(`[CRO] Running '${job.attrs.name}'...`);
    const year = new Date().getFullYear();
    const [res1, res2] = await Promise.all([
      axios.get(`${process.env.NATIONAL_HOLIDAY_BASE}/${year}.json`),
      axios.get(`${process.env.NATIONAL_HOLIDAY_BASE}/${year + 1}.json`)
    ]);
    const days = res1.data.days.concat(res2.data.days) as {
      name: string;
      date: string;
      isOffDay: boolean;
    }[];
    const conf = days.reduce(
      (conf: Config, day) => {
        if (day.isOffDay && [1, 2, 3, 4, 5].includes(moment(day.date).day())) {
          conf.offWeekdays?.push(day.date);
        } else if (!day.isOffDay && [0, 7].includes(moment(day.date).day())) {
          conf.onWeekends?.push(day.date);
        }
        return conf;
      },
      { offWeekdays: [], onWeekends: [] }
    );
    const [configItemOnWeekends, configItemOffWeekdays] = await Promise.all([
      configModel.findOne({ onWeekends: { $exists: true } }),
      configModel.findOne({ offWeekdays: { $exists: true } })
    ]);
    configItemOnWeekends?.set("onWeekends", conf.onWeekends);
    configItemOffWeekdays?.set("offWeekdays", conf.offWeekdays);
    await Promise.all([
      configItemOnWeekends?.save(),
      configItemOffWeekdays?.save()
    ]);
    console.log(`[CRO] Finished '${job.attrs.name}'.`);
    done();
  });

  agenda.define("verify user balance", async (job, done) => {
    console.log(`[CRO] Running '${job.attrs.name}'...`);
    const userBalanceMap: Record<string, number> = {};
    const userBalanceDepositMap: Record<string, number> = {};
    const balanceCards = await CardModel.find({
      type: "balance",
      status: CardStatus.ACTIVATED
    });
    balanceCards.forEach(c => {
      if (!c.customer) return;
      userBalanceMap[c.customer.toString()] =
        (c.balance || 0) + (userBalanceMap[c.customer.toString()] || 0);
      userBalanceDepositMap[c.customer.toString()] =
        c.price + (userBalanceDepositMap[c.customer.toString()] || 0);
    });
    console.log(`[CRO] Balance card added.`);
    const balancePayments = await paymentModel.find({
      gateway: PaymentGateway.Balance,
      paid: true
    });
    balancePayments.forEach(p => {
      if (!p.customer) return;
      userBalanceMap[p.customer.id] =
        (userBalanceMap[p.customer.id] || 0) - p.amount;
      userBalanceDepositMap[p.customer.id] =
        (userBalanceDepositMap[p.customer.id] || 0) - (p.amountDeposit || 0);
    });
    const users = await UserModel.find({
      _id: { $in: Object.keys(userBalanceMap) }
    });
    users.forEach(u => {
      const storedBalanceDeposit = u.balanceDeposit || 0;
      const storedBalance = u.balance || 0;
      userBalanceMap[u.id] = +userBalanceMap[u.id].toFixed(2);
      userBalanceDepositMap[u.id] = +userBalanceDepositMap[u.id].toFixed(2);
      if (storedBalance !== userBalanceMap[u.id]) {
        console.error(
          `[CRO] User balance mismatch: ${u.id} ${u.name} ${u.mobile} calc ${
            userBalanceDepositMap[u.id]
          }/${
            userBalanceMap[u.id]
          }, stored ${storedBalanceDeposit}/${storedBalance}`
        );
      }
    });
    console.log(`[CRO] Finished '${job.attrs.name}'.`);
    done();
  });

  agenda.define("verify user points", async (job, done) => {
    console.log(`[CRO] Running '${job.attrs.name}'...`);
    const { fix = false, userId = undefined } = job.attrs.data || {};
    try {
      const customerPointsMap: Record<string, number> = {};
      const customerPoints = await PaymentModel.aggregate([
        {
          $match: {
            customer: userId || { $exists: true },
            paid: true,
            gateway: { $ne: PaymentGateway.Coupon }
          }
        },
        {
          $group: {
            _id: "$customer",
            points: {
              $sum: {
                $cond: [{ $eq: ["$gateway", "balance"] }, "$amount", "$revenue"]
              }
            }
          }
        }
      ]);

      customerPoints.forEach(({ _id, points }) => {
        customerPointsMap[_id.toString()] = +points.toFixed();
      });

      const customerWrittenOffPoints = await PaymentModel.aggregate([
        {
          $match: {
            paid: true,
            amountInPoints: { $exists: true },
            customer: userId || { $exists: true }
          }
        },
        { $group: { _id: "$customer", points: { $sum: "$amountInPoints" } } }
      ]);

      customerWrittenOffPoints.forEach(({ _id, points }) => {
        customerPointsMap[_id.toString()] = +(
          customerPointsMap[_id.toString()] - points
        ).toFixed();
      });

      const users = await UserModel.find(userId ? { _id: userId } : {});
      for (const u of users) {
        const storedPoints = u.points || 0;
        customerPointsMap[u.id] = customerPointsMap[u.id] || 0;
        if (storedPoints - customerPointsMap[u.id] > 1) {
          u.points = customerPointsMap[u.id];
          if (fix) {
            await UserModel.updateOne(
              { _id: u.id },
              { points: customerPointsMap[u.id] }
            );
            await syncUserPoints(u);
            await sleep(200);
          }
          console.error(
            `[CRO] User points mismatch: ${u.id} ${u.name || ""} ${
              u.mobile || "UNKNOWN"
            } calc ${customerPointsMap[u.id]}, stored ${storedPoints}${
              fix ? ", fixed" : ""
            }.`
          );
        }
      }
      console.log(`[CRO] Finished '${job.attrs.name}'.`);
    } catch (e) {
      console.error(e);
    }
    done();
  });

  agenda.define("verify booking paid amount", async (job, done) => {
    console.log(`[CRO] Running '${job.attrs.name}'...`);
    const {
      date,
      type,
      fix = false
    } = job.attrs.data || { date: moment().format("YYYY-MM-DD"), type: "play" };
    const bookings = await BookingModel.find({ date, type });
    console.log(`[CRO] ${bookings.length} bookings found...`);
    for (const booking of bookings) {
      const amountPaid = booking.amountPaid;
      const amountPaidInBalance = booking.amountPaidInBalance;
      const amountPaidInDeposit = booking.amountPaidInDeposit;
      const amountPaidInCard = booking.amountPaidInCard;
      const amountPaidInPoints = booking.amountPaidInPoints;
      await booking.setAmountPaid();
      const diff: { key: string; stored?: number; calc?: number }[] = [];
      if (booking.amountPaid !== amountPaid) {
        diff.push({
          key: "amountPaid",
          stored: amountPaid,
          calc: booking.amountPaid
        });
      }
      if (booking.amountPaidInBalance !== amountPaidInBalance) {
        diff.push({
          key: "amountPaidInBalance",
          stored: amountPaidInBalance,
          calc: booking.amountPaidInBalance
        });
      }
      if (booking.amountPaidInDeposit !== amountPaidInDeposit) {
        diff.push({
          key: "amountPaidInDeposit",
          stored: amountPaidInDeposit,
          calc: booking.amountPaidInDeposit
        });
      }
      if (booking.amountPaidInCard !== amountPaidInCard) {
        diff.push({
          key: "amountPaidInCard",
          stored: amountPaidInCard,
          calc: booking.amountPaidInCard
        });
      }
      if (booking.amountPaidInPoints !== amountPaidInPoints) {
        diff.push({
          key: "amountPaidInPoints",
          stored: amountPaidInPoints,
          calc: booking.amountPaidInPoints
        });
      }
      if (diff.length) {
        console.log(
          `[CRO] Booking ${booking.id} amountPaid diff found: ${diff
            .map(i => `${i.key}:${i.stored}->${i.calc}`)
            .join(", ")}`
        );
      }
      if (fix) {
        await booking.save();
      }
    }
    console.log(`[CRO] Finished '${job.attrs.name}'.`);
    done();
  });

  agenda.define("generate wechat qrcode", async (job, done) => {
    console.log(`[CRO] Running '${job.attrs.name}'...`);
    const { path } = job.attrs.data || {};
    getQrcode(path);
    console.log(`[CRO] Finished '${job.attrs.name}'.`);
    done();
  });

  agenda.define("get wechat mp users", async (job, done) => {
    if (process.env.DISABLE_WECHAT_SYNC) {
      done();
    }
    console.log(`[CRO] Running '${job.attrs.name}'...`);
    const openids = await getMpUserOpenids();
    let start = 0;
    while (start < openids.length) {
      const chunk = openids.slice(start, start + 100);
      const usersInfo = await getUsersInfo(chunk);
      console.log(`[CRO] Got users info ${start} +100.`);
      const usersExists = await UserModel.find({
        unionid: { $in: usersInfo.filter(u => u.unionid).map(u => u.unionid) }
      }).where({ openidMp: null });
      if (usersExists.length) {
        console.log(
          `[CRO] ${usersExists.length} users matching unionid without openidMp.`
        );
      }
      for (const user of usersExists) {
        const userInfo = usersInfo.find(u => u.unionid === user.unionid);
        if (!userInfo) continue;
        await UserModel.updateOne(
          { _id: user.id },
          { openidMp: userInfo.openid }
        );
        console.log(
          `[CRO] User openidMp updated, user ${user.id}, openidMp ${userInfo.openid}`
        );
      }
      start += 100;
    }
    console.log(`[CRO] Finished '${job.attrs.name}'.`);
    done();
  });

  agenda.define("issue cards", async (job, done) => {
    console.log(`[CRO] Running '${job.attrs.name}'...`);
    const { slug, gateway, users } = job.attrs.data as {
      slug: string;
      gateway: PaymentGateway;
      users: [string, string, number?][];
    };
    const cardType = await CardTypeModel.findOne({ slug });
    if (!cardType) throw new Error("invalid_card_type");
    for (const [name, mobile, count = 1] of users) {
      let user = await UserModel.findOne({ mobile });
      if (!user) {
        user = new UserModel({ mobile, name, registeredAt: "手动导入" });
        await user.save();
        console.log(`[CRO] Created customer ${user.mobile} ${user.id}.`);
      }
      for (let i = 0; i < count; i++) {
        const card = cardType.issue(user);
        await card.save();
        console.log(
          `[CRO] Issued card ${card.id} (${slug}) #${i + 1} to customer ${
            user.mobile
          } ${user.id}.`
        );
        await card.createPayment({
          paymentGateway: gateway || PaymentGateway.Pos
        });
        if (card.status === CardStatus.PENDING) {
          card.paymentSuccess();
        }
        await card.save();
      }
    }
    console.log(`[CRO] Finished '${job.attrs.name}'.`);
    done();
  });

  agenda.define("generate gift card codes", async (job, done) => {
    console.log(`[CRO] Running '${job.attrs.name}'...`);
    const { cardIds } = (job.attrs.data as { cardIds: string[] }) || {
      cardIds: []
    };
    for (const cardId of cardIds) {
      const card = await CardModel.findById(cardId);
      if (!card) {
        console.error(`[CRO] Card ${cardId} not found.`);
        continue;
      }
      if (!card.isGift || card.status !== CardStatus.VALID) {
        console.error(`[CRO] Card ${cardId} is not gift.`);
        continue;
        // card.isGift = true;
        // card.status = CardStatus.VALID;
        // await card.save();
      }
      const weappQrPath = `/pages/index/index?giftCode=${card.id}-${card.customer}`;
      await getQrcode(weappQrPath, `output/qrcode-${card.slug}-${card.id}.jpg`);
    }
    console.log(`[CRO] Finished '${job.attrs.name}'.`);
    done();
  });

  agenda.define("generate period card revenue", async (job, done) => {
    console.log(`[CRO] Running '${job.attrs.name}'...`);
    const {
      clearDate = new Date(),
      start = undefined,
      end = undefined
    } = job.attrs.data || {};
    // clear period cards that ends in the previous month of clearDate or later
    // during the previous month on clearDate
    const periodEnd = end
      ? new Date(end)
      : moment(clearDate).subtract(1, "month").endOf("month").toDate();
    const periodStart = start
      ? new Date(start)
      : moment(clearDate).subtract(1, "month").startOf("month").toDate();
    const cards = await CardModel.find({
      status: { $ne: CardStatus.CANCELED },
      type: Scene.PERIOD,
      end: { $gte: periodStart },
      start: { $lte: periodEnd }
    });
    console.log(
      `[CRO] ${cards.length} cards to be count in ${moment(periodStart).format(
        "MMM"
      )}.`
    );
    for (const card of cards) {
      // pay amount / card period * period in this month
      // period in this month is (min(period end, month end) - max(period start, month start))
      if (!card.end || !card.start) {
        console.error(`[CRO] Card ${card.id} missing start of end date.`);
        continue;
      }

      const monthlyAmount =
        (card.price / (+card.end - +card.start + 1)) *
        (Math.min(+card.end, +periodEnd) -
          Math.max(+card.start, +periodStart) +
          1);

      if (!monthlyAmount) continue;

      const payment = new PaymentModel({
        scene: Scene.PERIOD,
        customer: card.customer,
        store: card.payments[0]?.store,
        amount: monthlyAmount,
        debt: -monthlyAmount,
        revenue: monthlyAmount,
        paid: true,
        title: `${card.title} ${
          start && end ? "一次性" : moment(periodStart).format("M") + "月"
        }核销`,
        card: card.id,
        gateway: PaymentGateway.Card,
        createdAt: periodEnd
      });

      await payment.save();
      const user = await UserModel.findById(payment.customer);
      await user?.addPoints(monthlyAmount);
    }
    console.log(`[CRO] Finished '${job.attrs.name}'.`);
    done();
  });

  agenda.define("sync history pospal tickets", async (job, done) => {
    console.log(`[CRO] Running '${job.attrs.name}'...`);
    const { code, dateStart, dateEnd } = job.attrs.data || {};
    const store = await StoreModel.findOne({ code });
    await store?.syncPospalTickets(dateStart, dateEnd);
    console.log(`[CRO] Finished '${job.attrs.name}'.`);
    done();
  });

  agenda.define("sync full day pospal tickets", async (job, done) => {
    console.log(`[CRO] Running '${job.attrs.name}'...`);
    const stores = await StoreModel.find();
    for (const store of stores) {
      const today = moment().format("YYYY-MM-DD");
      await store.syncPospalTickets(today, today);
    }
    console.log(`[CRO] Finished '${job.attrs.name}'.`);
    done();
  });

  agenda.define("sync pospal tickets", async (job, done) => {
    // console.log(`[CRO] Running '${job.attrs.name}'...`);
    if (process.env.DISABLE_POSPAL_SYNC) {
      return done();
    }
    // this job is run every minute, but we need more frequency, so we use for and sleep
    const peakInterval = 15;
    const troughInterval = 30;
    const open = "09:30";
    const close = "20:00";
    const peaks = ["11:30-14:00", "17:30-18:30"];
    const stores = await StoreModel.find();
    const time = moment().format("HH:mm");

    if (time < open || time > close) {
      return done();
    }

    const interval = peaks.some(peakStr => {
      const peak = peakStr.split("-");
      return time >= peak[0] && time < peak[1];
    })
      ? peakInterval
      : troughInterval;

    const timesInAMinute = Math.floor(60 / interval);

    for (let n = 0; n < timesInAMinute; n++) {
      stores.forEach(async store => {
        try {
          await store.syncPospalTickets(10);
        } catch (e) {
          return;
        }
      });
      await sleep(interval * 1000);
    }

    // console.log(`[CRO] Finished '${job.attrs.name}'.`);
    done();
  });

  agenda.define("sync pospal customers", async (job, done) => {
    if (process.env.DISABLE_POSPAL_SYNC) {
      return done();
    }
    try {
      console.log(`[CRO] Running '${job.attrs.name}'...`);
      const pospal = new Pospal();
      // download pospal customers
      const customers = await pospal.queryAllCustomers();
      for (const customer of customers) {
        if (!customer.phone || customer.enable !== 1) continue;
        const user = await UserModel.findOne({ mobile: customer.phone });
        if (!user || customer.customerUid.toString() === user.pospalId)
          continue;
        user.pospalId = customer.customerUid.toString();
        console.log(
          `[CRO] User ${user.id} ${user.mobile} pospal id set to ${user.pospalId}.`
        );
        await user.save();
      }
      // find bookings without customer, but has pospal customerUid
      const bookings = await BookingModel.find({
        date: moment().format("YYYY-MM-DD"),
        "providerData.provider": "pospal",
        "providerData.customerUid": { $exists: true }
      }).where({ customer: null });
      for (const booking of bookings) {
        const user = await UserModel.findOne({
          pospalId: booking.providerData?.customerUid
        });
        if (!user) continue;
        booking.customer = user;
        await booking.save();
        console.log(`[CRO] Booking ${booking.id} customer set to ${user.id}.`);
        for (const payment of booking.payments) {
          if (payment.customer) continue;
          payment.customer = user;
          await payment.save();
          console.log(
            `[CRO] Payment ${payment.id} customer set to ${user.id}.`
          );
        }
      }
      // upload balance customers to customer
      const users = await UserModel.find({
        $or: [{ balanceDeposit: { $gt: 0 } }, { balanceReward: { $gt: 0 } }]
      });
      for (const user of users) {
        try {
          await pospal.addMember(user);
        } catch (e) {
          console.error(
            `[CRO] Sync user ${user.id} ${user.mobile} to Pospal failed.`
          );
        }
      }
      console.log(`[CRO] Finished '${job.attrs.name}'.`);
      done();
    } catch (e) {
      console.error(e);
    }
  });

  agenda.define("sync pospal menus", async (job, done) => {
    if (process.env.DISABLE_POSPAL_SYNC) {
      return done();
    }
    try {
      console.log(`[CRO] Running '${job.attrs.name}'...`);
      const stores = await StoreModel.find();
      for (const store of stores) {
        try {
          const pospal = new Pospal(store.code);
          const menu = await pospal.getMenu();
          store.foodMenu = menu;
          await store.save();
          storeMap[store.id] = store;
          console.log(`[CRO] Store ${store.code} menu updated.`);
        } catch (err) {
          console.error(`[CRO] ${err.message}`);
          continue;
        }
      }

      console.log(`[CRO] Finished '${job.attrs.name}'.`);
      done();
    } catch (e) {
      console.error(e);
    }
  });

  agenda.define("check pospal payment methods", async (job, done) => {
    console.log(`[CRO] Running '${job.attrs.name}'...`);
    const stores = await StoreModel.find();
    for (const store of stores) {
      store.checkPospalPaymentMethods();
    }
    console.log(`[CRO] Finished '${job.attrs.name}'.`);
    done();
  });

  agenda.define("sync youzan points", async (job, done) => {
    console.log(`[CRO] Running '${job.attrs.name}'...`);

    const users = await UserModel.find({ youzanId: { $exists: true } });

    console.log("[CRO]", users.length, "users with youzanId found.");

    for (const user of users) {
      await syncUserPoints(user);
      await sleep(100);
    }

    console.log("[CRO] YouzanId users synced");

    const cards = await CardModel.find({
      slug: { $in: ["888", "yp-888", "jq-888", "jn-888", "ts-888"] }
    });

    for (const card of cards) {
      const user = await UserModel.findById(card.customer);
      if (!user || user?.pospalId) continue;
      syncUserPoints(user);
      await sleep(100);
    }

    console.log(`[CRO] Finished '${job.attrs.name}'.`);
    done();
  });

  agenda.define("init store doors", async (job, done) => {
    console.log(`[CRO] Running '${job.attrs.name}'...`);
    const { code } = job.attrs.data || {};
    const store = await StoreModel.findOne({ code });
    if (!store) {
      throw new Error("store_not_found");
    }
    store.initDoors();
    console.log(`[CRO] Finished '${job.attrs.name}'.`);
    done();
  });

  agenda.define("auth store doors", async (job, done) => {
    console.log(`[CRO] Running '${job.attrs.name}'...`);
    const { code, no } = job.attrs.data || {};
    const store = await StoreModel.findOne({ code });
    if (!store) {
      throw new Error("store_not_found");
    }
    store.authDoors(no);
    console.log(`[CRO] Finished '${job.attrs.name}'.`);
    done();
  });

  agenda.define("open store doors", async (job, done) => {
    console.log(`[CRO] Running '${job.attrs.name}'...`);
    const { code, name } = job.attrs.data || {};
    const store = await StoreModel.findOne({ code });
    if (!store) {
      throw new Error("store_not_found");
    }
    store.openDoor(name);
    console.log(`[CRO] Finished '${job.attrs.name}'.`);
    done();
  });

  agenda.start();

  agenda.on("ready", () => {
    agenda.every("5 minutes", "cancel expired pending bookings");
    agenda.every("5 minutes", "cancel expired pending cards");
    agenda.every("1 day", "finish in_service bookings");
    agenda.every("1 day", "update holidays");
    agenda.every("0 0 * * *", "set expired cards"); // run everyday at 0am
    agenda.every("1 day", "get wechat mp users");
    agenda.every("0 4 * * *", "verify user balance");
    agenda.every("30 4 * * *", "verify user points");
    agenda.every("0 16,20,22 * * *", "sync pospal customers");
    agenda.every("* * * * *", "sync pospal tickets");
    agenda.every("0 4 1 * *", "generate period card revenue");
    agenda.every("0 14,17 * * *", "sync pospal menus");
    agenda.every("30 10 * * *", "sync pospal menus");
    agenda.every("45 23 * * *", "sync full day pospal tickets");
  });

  agenda.on("error", err => {
    console.error(err.message);
  });
};

export default agenda;
