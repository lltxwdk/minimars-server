import { Router, Request, Response } from "express";
import handleAsyncErrors from "../utils/handleAsyncErrors";
import moment from "moment";
import getStats from "../utils/getStats";
import UserModel from "../models/User";
import CardModel, { CardStatus } from "../models/Card";
import { storeMap } from "../models/Store";

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
        req.query.store || req.user.store,
        !!req.query.popBookingCardCoupon
      );
      res.json(stats);
    })
  );

  return router;
};
