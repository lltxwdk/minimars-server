import { Router, Request, Response } from "express";
import handleAsyncErrors from "../utils/handleAsyncErrors";
import moment from "moment";
import getStats from "../utils/getStats";
import UserModel from "../models/User";
import CardModel, { CardStatus } from "../models/Card";
import StoreModel, { storeMap } from "../models/Store";
import xlsxTemplate from "xlsx-template";
import { unlinkSync, readFileSync, writeFileSync } from "fs";

moment.locale("zh-cn");

export default (router: Router) => {
  router.route("/stats/user-balance").get(
    handleAsyncErrors(async (req: Request, res: Response) => {
      const [
        { totalBalance, totalBalanceDeposit } = {
          totalBalance: 0,
          totalBalanceDeposit: 0
        }
      ] = await UserModel.aggregate([
        {
          $group: {
            _id: null,
            totalBalanceDeposit: {
              $sum: "$balanceDeposit"
            },
            totalBalanceReward: {
              $sum: "$balanceReward"
            }
          }
        },
        {
          $project: {
            _id: false,
            totalBalanceDeposit: true,
            totalBalance: {
              $sum: ["$totalBalanceDeposit", "$totalBalanceReward"]
            }
          }
        }
      ]);

      const [
        { totalValidCardBalance, totalValidCardBalanceDeposit } = {
          totalValidCardBalance: 0,
          totalValidCardBalanceDeposit: 0
        }
      ] = await CardModel.aggregate([
        { $match: { status: CardStatus.VALID } },
        {
          $group: {
            _id: null,
            totalValidCardBalanceDeposit: {
              $sum: "$price"
            },
            totalValidCardBalance: {
              $sum: "$balance"
            }
          }
        }
      ]);

      res.json({
        totalBalance,
        totalBalanceDeposit,
        totalValidCardBalance,
        totalValidCardBalanceDeposit
      });
    })
  );

  router.route("/stats/times-card").get(
    handleAsyncErrors(async (req: Request, res: Response) => {
      const totalTimesCardByStore: {
        _id: string[];
        customersCount: number;
        times: number;
        priceLeft: number;
      }[] = await CardModel.aggregate([
        {
          $match: {
            timesLeft: { $gt: 0 },
            type: "times",
            expiresAt: { $gte: new Date() },
            isContract: { $ne: true }
          }
        },
        {
          $group: {
            _id: "$stores",
            customers: { $addToSet: "$customer" },
            times: { $sum: "$timesLeft" },
            priceLeft: {
              $sum: {
                $multiply: [{ $divide: ["$timesLeft", "$times"] }, "$price"]
              }
            }
          }
        },
        {
          $project: {
            customersCount: { $size: "$customers" },
            times: 1,
            priceLeft: 1
          }
        }
      ]);

      const result = totalTimesCardByStore
        .sort((a, b) => {
          return JSON.stringify(a._id) > JSON.stringify(b._id) ? 1 : -1;
        })
        .map(storeGroup => {
          const storeNames =
            storeGroup._id
              .map(id => storeMap[id].name.substr(0, 2))
              .join("，") || "通用";
          return {
            storeNames,
            customersCount: storeGroup.customersCount,
            times: storeGroup.times,
            priceLeft: storeGroup.priceLeft
          };
        });

      res.json(result);
    })
  );

  router.route("/stats/:date?/:dateEnd?").get(
    handleAsyncErrors(async (req: Request, res: Response) => {
      const dateInput = req.params.date;
      const dateInputEnd = req.params.dateEnd;
      const stats = await getStats(
        dateInput,
        dateInputEnd,
        req.query.store || req.user.store?.id,
        !!req.query.popBookingCardCoupon,
        req.query.scene && req.query.scene.split(",")
      );
      res.json(stats);
    })
  );

  router.route("/daily-report/:date").get(
    handleAsyncErrors(async (req: Request, res: Response) => {
      const [date, dateEnd] = req.params.date.split("~");
      const template = new xlsxTemplate(
        readFileSync(
          `./reports/templates/${req.user.store ? "daily-store" : "daily"}.xlsx`
        )
      );

      const filename = `${
        req.user.store ? req.user.store.name : "运营部"
      }日报 ${req.params.date}.xlsx`;
      const path = `./reports/${filename}`;

      try {
        unlinkSync(path); // delete file if exists before generating a new report
      } catch (e) {
        // keep silent when file does not exist
      }

      const stores = await StoreModel.find().where({
        code: {
          $in: req.user.store
            ? [req.user.store.code]
            : ["TS", "JN", "BY", "HX", "DY"]
        }
      });
      const values: Record<string, any> = { date: req.params.date };
      if (req.user.store) {
        values.store = req.user.store.name;
      }
      await Promise.all(
        stores.map(async store => {
          const stats = await getStats(date, dateEnd || date, store.id, true);
          const timesCardSellAmount = stats.cardsSellCount
            .filter(item => item.type === "times" && !item.isContract)
            .reduce((sum, item) => +(sum + item.amount).toFixed(2), 0);
          const periodCardSellAmount = stats.cardsSellCount
            .filter(item => item.type === "period" && !item.isContract)
            .reduce((sum, item) => +(sum + item.amount).toFixed(2), 0);
          const balanceSellAmount = stats.assetsByScenes.balance;
          const totalCardSellAmount = stats.cardsSellCount.reduce(
            (sum, item) => +(sum + item.amount).toFixed(2),
            0
          );
          const otherCardSellAmount = +(
            totalCardSellAmount -
            timesCardSellAmount -
            periodCardSellAmount
          ).toFixed(2);

          const storeValues = {
            playBookings: stats.bookingsCountByType.play,
            customerCount: stats.customers,
            timesCardSellAmount,
            periodCardSellAmount,
            balanceSellAmount,
            otherCardSellAmount,
            guestPlayAmount: +stats.customersByType.guest.amountPaid.toFixed(2),
            couponPlayAmount:
              +stats.customersByType.coupon.amountPaid.toFixed(2),
            assets: +stats.assets.toFixed(2),
            playAmount: +(stats.revenueByScenes.play || 0).toFixed(2),
            foodAmount: +(stats.revenueByScenes.food || 0).toFixed(2),
            eventAmount: +(stats.revenueByScenes.event || 0).toFixed(2),
            partyAmount: +(stats.revenueByScenes.party || 0).toFixed(2),
            foodSalesAmount: +(stats.amountByScenes.food || 0).toFixed(2),
            eventSalesAmount: +(stats.amountByScenes.event || 0).toFixed(2),
            guestPlayBookingsCount: stats.customersByType.guest.count,
            couponPlayBookingsCount: stats.customersByType.coupon.count,
            cardPlayBookingsCount: stats.customersByType.card.count,
            cardsCount: stats.cardsSellCount.reduce(
              (count, item) =>
                count + (item.type === "coupon" ? 0 : item.count),
              0
            ),
            firstCardsCount: stats.cardsSellFirstTimesCount,
            renewCardsCount: stats.cardsSellRenewTimesCount,
            foodBookingsCount: stats.bookingsCountByType.food,
            foodBookingAvgAmount: +(
              stats.amountByScenes.food / stats.bookingsCountByType.food
            ).toFixed(2),
            eventBookingsCount: stats.bookingsCountByType.event || 0,
            foodSetsCount: stats.foodSetsCount || 0
          } as Record<string, any>;

          for (const field in storeValues) {
            if (req.user.store) {
              values[field] = storeValues[field];
            } else {
              values[`${store.code}_${field}`] = storeValues[field];
            }
          }
        })
      );

      template.substitute(1, values);

      const data = template.generate({ type: "nodebuffer" }) as Buffer;
      writeFileSync(path, data);

      res.download(path, filename);
    })
  );

  return router;
};
