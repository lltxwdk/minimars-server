import { Router, Request, Response, NextFunction } from "express";
import moment from "moment";
import xlsx from "xlsx";
import paginatify from "../middlewares/paginatify";
import handleAsyncErrors from "../utils/handleAsyncErrors";
import parseSortString from "../utils/parseSortString";
import HttpError from "../utils/HttpError";
import PaymentModel, {
  gatewayNames,
  Payment,
  PaymentGateway,
  receptionGateways,
  Scene,
  SceneLabel
} from "../models/Payment";
import StoreModel from "../models/Store";
import { PaymentQuery, PaymentPutBody } from "./interfaces";
import escapeStringRegexp from "escape-string-regexp";
import { DocumentType } from "@typegoose/typegoose";
import { Permission } from "../models/Role";

export default (router: Router) => {
  // Payment CURD
  router
    .route("/payment")

    // get all the payments
    .get(
      paginatify,
      handleAsyncErrors(async (req: Request, res: Response) => {
        const queryParams = req.query as PaymentQuery;
        const { limit, skip } = req.pagination;
        const query = PaymentModel.find();
        const sort = parseSortString(queryParams.order) || {
          createdAt: -1
        };

        if (!req.user.role) {
          query.find({ customer: req.user });
        } else if (
          req.user.can(Permission.PAYMENT) &&
          !req.user.can(Permission.BOOKING_ALL_STORE)
        ) {
          query.find({ store: { $in: [req.user.store?.id, null] } });
        } else if (!req.user.can(Permission.PAYMENT)) {
          throw new HttpError(403);
        }

        if (queryParams.date) {
          const start = moment(queryParams.date).startOf("day");
          const end = moment(queryParams.dateEnd || queryParams.date).endOf(
            "day"
          );
          query.find({ createdAt: { $gte: start, $lte: end } });
        }

        if (queryParams.paid) {
          if (queryParams.paid === "false") {
            query.find({ paid: false });
          } else {
            query.find({ paid: true });
          }
        }

        if (queryParams.attach) {
          if (queryParams.attach === "booking") {
            query.where({ booking: { $exists: true } });
          }
          if (queryParams.attach === "card") {
            query.where({ card: { $exists: true } });
          }
        }

        if (queryParams.title) {
          query.find({
            title: new RegExp("^" + escapeStringRegexp(queryParams.title))
          });
        }

        if (queryParams.gateway) {
          const gateways = queryParams.gateway.includes(",")
            ? (queryParams.gateway.split(",") as PaymentGateway[])
            : (queryParams.gateway as PaymentGateway);
          query.find({
            gateway: {
              $in: Array.isArray(gateways) ? gateways : [gateways]
            }
          });
        }

        if (queryParams.direction === "payment") {
          query.find({
            amount: { $gt: 0 }
          });
        }

        if (queryParams.direction === "refund") {
          query.find({
            amount: { $lt: 0 }
          });
        }

        (["store", "customer"] as Array<keyof PaymentQuery>).forEach(field => {
          if (queryParams[field]) {
            query.find({ [field]: queryParams[field] });
          }
        });

        if (queryParams.amount) {
          const amounts = queryParams.amount
            .split(/[\/\s、，]+/)
            .filter(a => a)
            .map(a => +a);
          query.find({ amount: { $in: amounts } });
        }

        if (queryParams.scene) {
          query.find({
            scene: { $in: queryParams.scene.split(",") as Scene[] }
          });
        }

        let total = await query.countDocuments();
        const [
          { totalAmount } = { totalAmount: 0 }
        ] = await PaymentModel.aggregate([
          //@ts-ignore
          { $match: query._conditions },
          {
            $group: {
              _id: null,
              totalAmount: {
                $sum: "$revenue"
              }
            }
          }
        ]);

        const page = await query
          .find()
          .sort(sort)
          .limit(limit)
          .skip(skip)
          .exec();

        if (skip + page.length > total) {
          total = skip + page.length;
        }

        res.set("total-amount", totalAmount.toFixed(2));

        res.paginatify(limit, skip, total).json(page);
      })
    );

  router.route("/payment-sheet").get(
    handleAsyncErrors(async (req: Request, res: Response) => {
      if (!req.user.can(Permission.PAYMENT_DOWNLOAD)) {
        throw new HttpError(403);
      }
      const queryParams = req.query as PaymentQuery;
      const query = PaymentModel.find().sort({ _id: -1 });

      if (!req.user.can(Permission.BOOKING_ALL_STORE)) {
        query.find({ store: req.user.store?.id });
      }

      if (queryParams.date) {
        if (queryParams.dateEnd === "null") delete queryParams.dateEnd;
        const start = moment(queryParams.date, "YYYY-MM-DD").startOf("day");
        const end = moment(
          queryParams.dateEnd || queryParams.date,
          "YYYY-MM-DD"
        ).endOf("day");
        query.find({ createdAt: { $gte: start, $lte: end } });
      }

      if (queryParams.paid) {
        if (queryParams.paid === "false") {
          query.find({ paid: false });
        } else {
          query.find({ paid: true });
        }
      }

      if (queryParams.attach) {
        if (queryParams.attach === "booking") {
          query.where({ booking: { $exists: true } });
        }
        if (queryParams.attach === "card") {
          query.where({ card: { $exists: true } });
        }
      }

      if (queryParams.title) {
        query.find({
          title: new RegExp("^" + escapeStringRegexp(queryParams.title))
        });
      }

      if (queryParams.gateway) {
        const gateways = queryParams.gateway.includes(",")
          ? (queryParams.gateway.split(",") as PaymentGateway[])
          : (queryParams.gateway as PaymentGateway);
        query.find({
          gateway: {
            $in: Array.isArray(gateways) ? gateways : [gateways]
          }
        });
      }

      if (queryParams.direction === "payment") {
        query.find({
          amount: { $gt: 0 }
        });
      }

      if (queryParams.direction === "refund") {
        query.find({
          amount: { $lt: 0 }
        });
      }

      (["store", "customer"] as Array<keyof PaymentQuery>).forEach(field => {
        if (queryParams[field]) {
          query.find({ [field]: queryParams[field] });
        }
      });

      if (queryParams.amount) {
        const amounts = queryParams.amount
          .split(/[\/\s、，]+/)
          .filter(a => a)
          .map(a => +a);
        query.find({ amount: { $in: amounts } });
      }

      if (queryParams.scene) {
        query.find({ scene: { $in: queryParams.scene.split(",") as Scene[] } });
      }

      const payments = await query.find().limit(5e3).exec();

      /* original data */
      const filename = "支付明细.xlsx";
      const path = "/tmp/" + filename;
      const data: any[][] = [
        [
          "手机",
          "完成",
          "资产",
          "负债",
          "收入",
          "余额",
          "次数",
          "会员卡",
          "平台券",
          "门店",
          "业务场景",
          "明细",
          "支付方式",
          "时间"
        ]
      ];

      const stores = await StoreModel.find();

      payments.forEach(payment => {
        const row = [
          payment.customer?.mobile || "",
          payment.paid,
          payment.assets,
          payment.debt,
          payment.revenue,
          payment.balance || "-",
          payment.times || "-",
          payment.gatewayData.cardTitle || "-",
          payment.gatewayData.couponTitle || "-",
          (
            stores.find(s => s.id === (payment.store || "").toString()) || {
              name: "-"
            }
          ).name,
          SceneLabel[payment.scene],
          payment.title,
          gatewayNames[payment.gateway],
          moment((payment as any).createdAt).format("YYYY-MM-DD HH:mm")
        ];
        data.push(row);
      });

      const ws_name = filename.replace(/\.xlsx$/, "");
      const wb = xlsx.utils.book_new(),
        ws = xlsx.utils.aoa_to_sheet(data);

      /* add worksheet to workbook */
      xlsx.utils.book_append_sheet(wb, ws, ws_name);

      /* write workbook */
      xlsx.writeFile(wb, path);
      res.download(path, filename);
    })
  );

  router
    .route("/payment/:paymentId")

    .all(
      handleAsyncErrors(
        async (req: Request, res: Response, next: NextFunction) => {
          if (!req.user.can(Permission.PAYMENT)) {
            throw new HttpError(403);
          }
          const payment = await PaymentModel.findById(req.params.paymentId);
          if (!payment) {
            throw new HttpError(
              404,
              `Payment not found: ${req.params.paymentId}`
            );
          }
          req.item = payment;
          next();
        }
      )
    )

    // get the payment with that id
    .get(
      handleAsyncErrors(async (req: Request, res: Response) => {
        const payment = req.item;
        res.json(payment);
      })
    )

    .put(
      handleAsyncErrors(async (req: Request, res: Response) => {
        const payment = req.item as DocumentType<Payment>;
        const body = req.body as PaymentPutBody;

        if (
          !req.user.can(Permission.PAYMENT) &&
          receptionGateways.includes(payment.gateway)
        ) {
          (["paid", "gateway"] as Array<keyof Payment>).forEach(key => {
            if (body[key] !== undefined) {
              payment.set(key, body[key]);
            }
          });
        } else if (req.user.can(Permission.PAYMENT)) {
          payment.set(body);
        } else {
          throw new HttpError(403);
        }

        await payment.save();
        res.json(payment);
      })
    )

    // delete the payment with this id
    .delete(
      handleAsyncErrors(async (req: Request, res: Response) => {
        const payment = req.item as DocumentType<Payment>;
        await payment.remove();
        res.end();
      })
    );

  return router;
};
