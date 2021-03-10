import { Router, Request, Response, NextFunction } from "express";
import moment from "moment";
import { readFileSync } from "fs";
import paginatify from "../middlewares/paginatify";
import handleAsyncErrors from "../utils/handleAsyncErrors";
import parseSortString from "../utils/parseSortString";
import HttpError from "../utils/HttpError";
import BookingModel, {
  Booking,
  BookingStatus,
  paidBookingStatus
} from "../models/Booking";
import UserModel from "../models/User";
import PaymentModel, { PaymentGateway, Scene } from "../models/Payment";
import CardModel, { CardStatus } from "../models/Card";
import { config } from "../models/Config";
import {
  BookingPostBody,
  BookingPostQuery,
  BookingPutBody,
  BookingQuery,
  BookingPricePostBody
} from "./interfaces";
import { DocumentType } from "@typegoose/typegoose";
import { isValidHexObjectId, isOffDay } from "../utils/helper";
import { viso } from "../utils/Viso";

export default (router: Router) => {
  // Booking CURD
  router
    .route("/booking")

    // create a booking
    .post(
      handleAsyncErrors(async (req: Request, res: Response) => {
        const body = req.body as BookingPostBody;
        const query = req.query as BookingPostQuery;

        if (body.status && req.user.role !== "admin") {
          delete body.status;
          // throw new HttpError(403, "Only admin can set status directly.");
        }

        const booking = new BookingModel(body);

        if (!booking.customer) {
          if (req.user.role === "customer") {
            booking.customer = req.user._id;
          } else if (
            // create a user with mobile given before create booking
            query.customerKeyword &&
            ["admin", "manager", "eventManager"].includes(req.user.role)
          ) {
            booking.customer = new UserModel({
              role: "customer",
              mobile: query.customerKeyword
            });
            await booking.customer.validate();
          }
        }

        if (!booking.populated("customer")) {
          await booking.populate("customer").execPopulate();
        }

        if (!booking.customer) {
          throw new HttpError(400, "客户信息错误");
        }

        console.log(
          `[BOK] Create booking for customer ${booking.customer.mobile} ${booking.customer.id}.`
        );

        await booking.populate("store").execPopulate();

        if (!booking.store || !booking.store.name) {
          if (booking.type !== Scene.GIFT) {
            throw new HttpError(400, "门店信息错误");
          }
        }

        if (!booking.date) {
          booking.date = moment().format("YYYY-MM-DD");
        }

        if (!booking.checkInAt) {
          booking.checkInAt = config.appointmentDeadline || "16:00:00";
        }

        if (
          req.user.role === "customer" &&
          !booking.customer.equals(req.user)
        ) {
          throw new HttpError(403, "只能为自己预订");
        }

        if (booking.type === Scene.PLAY) {
          if (!booking.store) throw new Error("missing_booking_store");
          if (!booking.kidsCount) {
            booking.kidsCount = 0;
          }
          if (!booking.adultsCount) {
            booking.adultsCount = 0;
          }
          if (booking.card) {
            const otherBookings = await BookingModel.find({
              card: booking.card,
              status: { $in: paidBookingStatus },
              date: booking.date
            });
            const kidsCountToday =
              booking.kidsCount +
              otherBookings.reduce((c, b) => c + (b.kidsCount || 0), 0);
            if (!booking.populated("card")) {
              await booking.populate("card", "-content").execPopulate();
            }
            if (
              booking.card.stores.length &&
              !booking.card.stores.includes(booking.store.id)
            ) {
              throw new HttpError(400, "会员卡不支持该门店");
            }
            if (
              booking.card.maxKids &&
              kidsCountToday > booking.card.maxKids &&
              req.user.role !== "admin"
            ) {
              throw new HttpError(400, "客户会员卡当日预约已到达最大孩子数量");
            }

            if (booking.kidsCount < booking.card.minKids) {
              throw new HttpError(
                400,
                `该会员卡须至少预约${booking.card.minKids}个孩子`
              );
            }

            if (
              booking.card.dayType === "onDaysOnly" &&
              isOffDay(booking.date)
            ) {
              throw new HttpError(400, "该卡只能在法定工作日使用");
            }
            if (
              booking.card.dayType === "offDaysOnly" &&
              !isOffDay(booking.date)
            ) {
              throw new HttpError(400, "该卡只能在法定节假日使用");
            }
          }

          if (req.ua.isWechat || booking.date > moment().format("YYYY-MM-DD")) {
            try {
              if (booking.coupon) {
                await booking.checkStoreLimit("coupon");
              } else {
                await booking.checkStoreLimit();
              }
            } catch (e) {
              switch (e.message) {
                case "store_limit_exceeded":
                  throw new HttpError(400, "抱歉，该门店当日已达预约上限");
                default:
                  throw e;
              }
            }
          }
        }

        if (body.type === Scene.EVENT) {
          if (!booking.populated("event")) {
            await booking
              .populate({ path: "event", select: "-content" })
              .execPopulate();
          }
          if (!booking.event) {
            throw new HttpError(400, "活动信息错误");
          }
          if (
            booking.event.kidsCountLeft !== null &&
            body.kidsCount !== undefined &&
            booking.event.kidsCountLeft < body.kidsCount
          ) {
            throw new HttpError(400, "活动儿童人数名额不足");
          }

          if (
            booking.event.date &&
            moment(booking.date).toDate() > booking.event.date
          ) {
            throw new HttpError(400, "活动日期已过，无法预约报名");
          }
        }

        if (body.type === Scene.GIFT) {
          if (booking.quantity === undefined)
            throw new Error("invalid_quantity");
          if (!booking.populated("gift")) {
            await booking.populate("gift").execPopulate();
          }
          if (!booking.gift) {
            throw new HttpError(400, "礼品信息错误");
          }
          if (
            booking.gift.quantity >= 0 &&
            booking.gift.quantity < booking.quantity
          ) {
            throw new HttpError(400, "礼品库存不足");
          }
          if (booking.gift.maxQuantityPerCustomer) {
            const historyGiftBookings = await BookingModel.find({
              type: Scene.GIFT,
              status: { $in: paidBookingStatus },
              gift: booking.gift,
              customer: booking.customer
            });
            const historyQuantity = historyGiftBookings.reduce(
              (quantity, booking) => quantity + (booking.quantity || 0),
              0
            );
            if (
              historyQuantity + booking.quantity >
              booking.gift.maxQuantityPerCustomer
            ) {
              throw new HttpError(400, "超过客户礼品限制兑换数");
            }
          }
        }

        if (booking.type === Scene.FOOD) {
          if (!booking.price) {
            const card = await CardModel.findById(booking.card);
            if (
              card &&
              (card.fixedPrice === null || card.fixedPrice === undefined)
            ) {
              throw new HttpError(400, "请填写收款金额");
            }
          }
          if (process.env.DISABLE_FOOD_BALANCE && !booking.card) {
            throw new HttpError(
              400,
              "禁止在本系统创建餐饮订单，请使用银豹系统，订单会在10分钟内自动同步至本系统"
            );
          }
        }

        try {
          const bookingPrice = await booking.calculatePrice();
          if (booking.customer.isNew) {
            await booking.customer.save();
          }
          await booking.createPayment(
            {
              paymentGateway:
                query.paymentGateway ||
                (req.ua.isWechat ? PaymentGateway.WechatPay : undefined),
              useBalance: query.useBalance !== "false",
              atReception:
                ["manager", "eventManager"].includes(req.user.role) &&
                booking.customer.id !== req.user.id
            },
            bookingPrice.price,
            bookingPrice.priceInPoints
          );
        } catch (err) {
          switch (err.message) {
            case "coupon_not_found":
              throw new HttpError(400, "优惠不存在");
            case "no_customer_openid":
              throw new HttpError(400, "缺少客户openid");
            case "incomplete_gateway_data":
              throw new HttpError(400, "微信支付信息错误");
            case "insufficient_balance":
              throw new HttpError(400, "客户账户余额不足");
            case "insufficient_points":
              throw new HttpError(400, "客户账户积分不足");
            case "card_expired":
              throw new HttpError(400, "会员卡已失效");
            case "card_not_started":
              throw new HttpError(400, "会员卡未生效");
            case "insufficient_card_times":
              throw new HttpError(400, "次卡剩余次数不足");
            case "missing_gateway":
              throw new HttpError(400, "未选择支付方式");
            case "points_gateway_not_supported":
              throw new HttpError(400, "不支持积分购买");
            case "coupon_kids_count_not_match":
              throw new HttpError(400, "孩子数量不是优惠孩子数量的整数倍");
            default:
              throw err;
          }
        }

        await booking.save();

        res.json(booking);
      })
    )

    // get all the bookings
    .get(
      paginatify,
      handleAsyncErrors(async (req: Request, res: Response) => {
        const queryParams = req.query as BookingQuery;
        const { limit, skip } = req.pagination;
        const query = BookingModel.find();
        const sort = parseSortString(queryParams.order) || {
          createdAt: -1
        };

        // restrict self bookings for customers
        if (req.user.role === "customer") {
          query.find({ customer: req.user._id });
        } else if (["manager", "eventManager"].includes(req.user.role)) {
          query.find({ store: { $in: [req.user.store?.id, null] } });
        } else if (req.user.role !== "admin") {
          throw new HttpError(403);
        }

        if (queryParams.status) {
          query.find({
            status: {
              $in: queryParams.status.split(",") as BookingStatus[]
            }
          });
        }

        if (queryParams.customerKeyword) {
          if (isValidHexObjectId(queryParams.customerKeyword)) {
            // @ts-ignore
            query.where({ customer: queryParams.customerKeyword });
          } else {
            const matchCustomers = await UserModel.find({
              $text: { $search: queryParams.customerKeyword }
            });
            query.where({ customer: { $in: matchCustomers } });
          }
        }

        if (queryParams.paymentType) {
          switch (queryParams.paymentType) {
            case "guest":
              query.where({ coupon: null, card: null });
              break;
            case "coupon":
              query.where({ coupon: { $ne: null } });
              break;
            case "card":
              query.where({ card: { $ne: null } });
              break;
          }
        }

        ([
          "type",
          "store",
          "date",
          "customer",
          "event",
          "gift",
          "coupon"
        ] as Array<keyof BookingQuery>).forEach(field => {
          if (queryParams[field]) {
            query.find({ [field]: queryParams[field] });
          }
        });

        let total = await query.countDocuments();

        const page = await query
          .find()
          .sort(sort)
          .limit(limit)
          .skip(skip)
          .exec();

        if (skip + page.length > total) {
          total = skip + page.length;
        }

        res.paginatify(limit, skip, total).json(page);
      })
    );

  router
    .route("/booking/:bookingId")

    .all(
      handleAsyncErrors(
        async (req: Request, res: Response, next: NextFunction) => {
          const booking = await BookingModel.findOne({
            _id: req.params.bookingId
          });
          if (!booking) {
            throw new HttpError(
              404,
              `Booking not found: ${req.params.bookingId}`
            );
          }
          if (req.user.role === "customer") {
            if (!booking.customer?.equals(req.user)) {
              throw new HttpError(403);
            }
          }
          req.item = booking;
          next();
        }
      )
    )

    // get the booking with that id
    .get(
      handleAsyncErrors(async (req: Request, res: Response) => {
        const booking = req.item;
        res.json(booking);
      })
    )

    .put(
      handleAsyncErrors(async (req: Request, res: Response) => {
        const booking = req.item as DocumentType<Booking>;

        // TODO restrict for roles

        const statusWas = booking.status;
        const facesWas = booking.faces?.join();

        booking.set(req.body as BookingPutBody);

        await booking.populate("customer").execPopulate();
        await booking.populate("store").execPopulate();

        if (
          statusWas !== BookingStatus.CANCELED &&
          booking.status === BookingStatus.CANCELED
          // req.user.role !== "admin"
        ) {
          // TODO refund permission should be restricted
          // TODO IN_SERVICE refund

          booking.status = statusWas;
          if (
            req.user.role === "customer" &&
            statusWas !== BookingStatus.PENDING
          ) {
            booking.statusWas = booking.status;
            booking.status = BookingStatus.PENDING_REFUND;
            booking.remarks =
              booking.remarks ||
              "" +
                `\n${moment().format("YYYY-MM-DD HH:mm")} 客户申请取消，原因：${
                  req.query.reason
                }。*小程序端可见*`;
          } else if (req.user.role === "manager") {
            booking.statusWas = booking.status;
            booking.status = BookingStatus.PENDING_REFUND;
            await CardModel.updateMany(
              { rewardedFromBooking: booking, status: CardStatus.ACTIVATED },
              { status: CardStatus.PENDING }
            );
          } else {
            try {
              await CardModel.updateMany(
                {
                  rewardedFromBooking: booking,
                  status: { $in: [CardStatus.ACTIVATED, CardStatus.PENDING] }
                },
                { status: CardStatus.CANCELED }
              );
              await booking.cancel(false);
            } catch (e) {
              if (
                e.message === "wechat_account_insufficient_balance" &&
                req.user.role === "admin"
              ) {
                throw new HttpError(400, "微信商户余额不足，退款失败");
              }
              throw e;
            }
            if (
              booking.remarks &&
              booking.remarks.match &&
              booking.remarks.match(/\*小程序端\*/) &&
              booking.remarks.match(/客户申请取消/)
            ) {
              booking.remarks += `\n${moment().format(
                "YYYY-MM-DD HH:mm"
              )} 取消申请通过，已发起退款，微信支付将在1-7天内原路退回。*小程序端可见*`;
            }
          }
        }

        if (
          statusWas === BookingStatus.PENDING_REFUND &&
          booking.status === booking.statusWas
        ) {
          // admin reject cancel booking
          // recover pending rewarded cards now
          await CardModel.updateMany(
            { rewardedFromBooking: booking, status: CardStatus.PENDING },
            { status: CardStatus.ACTIVATED }
          );
        }

        if (
          statusWas !== BookingStatus.IN_SERVICE &&
          booking.status === BookingStatus.IN_SERVICE
        ) {
          booking.checkIn(false);
        }

        if (
          statusWas === BookingStatus.IN_SERVICE &&
          booking.status === BookingStatus.FINISHED &&
          !booking.checkOutAt
        ) {
          booking.checkOutAt = moment().format("HH:mm:ss");
        }

        if (facesWas !== booking.faces?.join()) {
          if (!booking.store || !booking.customer)
            throw new Error("invalid_customer");
          booking.faces?.forEach((url, index) => {
            const path = url.replace(/^.+?\/\/.+?\//, "");
            const base64 = readFileSync(path, { encoding: "base64" });
            const data = "data:image/jpeg;base64," + base64;
            const personNumber = `${booking.id}-${Date.now()}`;
            if (!booking.store || !booking.customer)
              throw Error("invalid_booking");
            viso.addPerson(
              booking.store,
              personNumber,
              [data],
              booking.customer.mobile
            );
            viso.addWhitelist(booking.store, [personNumber]);
          });
        }

        await booking.save();
        // sendConfirmEmail(booking);
        res.json(booking);
      })
    )

    // delete the booking with this id
    .delete(
      handleAsyncErrors(async (req: Request, res: Response) => {
        if (req.user.role !== "admin") {
          throw new HttpError(403);
        }

        const booking = req.item as DocumentType<Booking>;

        if (booking.payments.some(p => p.paid)) {
          throw new HttpError(403, "已有成功付款记录，无法删除");
        }

        await PaymentModel.deleteMany({
          _id: { $in: booking.payments.map(p => p.id) }
        });
        await booking.remove();
        res.end();
      })
    );

  router.route("/booking-price").post(
    handleAsyncErrors(async (req: Request, res: Response) => {
      const booking = new BookingModel(req.body as BookingPricePostBody);

      if (!booking.customer) {
        booking.customer = req.user;
      }
      await booking.populate("customer").execPopulate();

      if (!booking.customer) {
        throw new HttpError(401, "客户信息错误");
      }

      await booking.populate("store").execPopulate();

      if (!booking.date) {
        booking.date = moment().format("YYYY-MM-DD");
      }

      if (!booking.checkInAt) {
        booking.checkInAt = moment().add(5, "minutes").format("HH:mm:ss");
      }

      try {
        const bookingPrice = await booking.calculatePrice();
        res.json(bookingPrice);
      } catch (err) {
        switch (err.message) {
          case "coupon_not_found":
            throw new HttpError(400, "优惠不存在");
          default:
            throw err;
        }
      }
    })
  );

  return router;
};
