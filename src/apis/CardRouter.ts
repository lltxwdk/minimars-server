import { Router, Request, Response, NextFunction } from "express";
import paginatify from "../middlewares/paginatify";
import handleAsyncErrors from "../utils/handleAsyncErrors";
import parseSortString from "../utils/parseSortString";
import HttpError from "../utils/HttpError";
import CardModel, {
  Card,
  CardStatus,
  userVisibleCardStatus
} from "../models/Card";
import CardType from "../models/CardType";
import Payment, { PaymentGateway } from "../models/Payment";
import UserModel from "../models/User";
import CardTypeModel from "../models/CardType";
import BookingModel, {
  BookingStatus,
  paidBookingStatus
} from "../models/Booking";
import {
  CardPostBody,
  CardPutBody,
  CardQuery,
  CardPostQuery
} from "./interfaces";
import { DocumentType } from "@typegoose/typegoose";
import { verify } from "jsonwebtoken";
import moment from "moment";
import { sendTemplateMessage, TemplateMessageType } from "../utils/wechat";
import { Permission } from "../models/Role";
import StoreModel, { Store } from "../models/Store";

export default (router: Router) => {
  // Card CURD
  router
    .route("/card")

    // create a card
    .post(
      handleAsyncErrors(async (req: Request, res: Response) => {
        const body = req.body as CardPostBody;

        const customer = !req.user.role
          ? req.user
          : await UserModel.findById(body.customer);

        if (!customer) {
          throw new HttpError(400, "购卡用户无效");
        }

        if (!customer.mobile) {
          throw new HttpError(400, "必须先授权获取手机号才能购买/领取会员卡");
        }

        if (body.giftCode) {
          try {
            let userId: string, cardId: string;

            const directMatch = body.giftCode.match(
              /([a-fA-F0-9]{24})-([a-fA-F0-9]{24})/
            );
            if (directMatch) {
              cardId = directMatch[1];
              userId = directMatch[2];
            } else {
              [userId, cardId] = (
                verify(body.giftCode, process.env.APP_SECRET || "") as string
              ).split(" ");
            }

            console.log(
              `[CRD] Gift code parsed, user: ${userId}, card: ${cardId}.`
            );

            const card = await CardModel.findOne({ _id: cardId });
            if (!card) throw new Error("invalid_card");
            if (card.customer?.toString() === userId) {
              // verify success, now change owner
              const sender = await UserModel.findById(card.customer);
              const receiver = await UserModel.findById(
                body.customer || req.user.id
              );
              if (!sender || !receiver)
                throw new Error("invalid_gift_card_sender_receiver");
              card.customer = body.customer || req.user.id;
              await card.save();
              console.log(
                `[CRD] Card ${card.id} transferred from user ${userId} to ${card.customer}.`
              );
              sendTemplateMessage(
                sender,
                TemplateMessageType.GIFT_CARD_RECEIVED,
                [
                  `您分享的卡片已被${receiver.name || ""}领取`,
                  card.title,
                  card.balance ? `${card.balance.toFixed()}元` : "",
                  receiver.mobile || "",
                  moment(card.expiresAt).format("YYYY-MM-DD"),
                  ""
                ]
              );
              return res.json(card);
            } else if (card.customer?.toString() === req.user.id) {
              return res.json(card);
            } else {
              throw "";
            }
          } catch (e) {
            throw new HttpError(403, "礼品卡代码无效");
          }
        }

        const query = req.query as CardPostQuery;
        const cardType = await CardType.findOne({ slug: body.slug });
        if (!cardType) {
          throw new HttpError(404, `CardType '${body.slug}' not exists.`);
        }

        if (req.user.can(Permission.CARD_SELL_STORE)) {
          if (!cardType.stores.some(s => s.id === req.user.store?.id)) {
            throw new HttpError(403, "无法销售非本门店卡");
          }
        } else if (req.user.can(Permission.CARD_SELL_ALL)) {
          //
        } else if (req.user.can(Permission.CARD_ISSUE_SURVEY)) {
          if (!body.rewardedFromBooking) {
            throw new HttpError(
              400,
              "Missing required property: rewardedFromBooking."
            );
          }
          if (cardType.price) {
            throw new HttpError(400, "无权发送这张卡券");
          }
          const booking = await BookingModel.findOne({
            customer,
            date: moment().format("YYYY-MM-DD"),
            status: { $ne: BookingStatus.CANCELED }
          });
          if (!booking) {
            throw new HttpError(400, "该用户没有当日有效订单，无法发送卡券");
          }
        } else if (req.user.id !== customer.id) {
          throw new HttpError(403, "无法为他人购卡");
        }

        if (body.quantity && body.quantity > 1 && cardType.type !== "times") {
          throw new HttpError(400, "只有次卡支持一次购买多张");
        }

        if (cardType.maxPerCustomer) {
          const cardsOfSlug = await CardModel.find({
            slug: cardType.slug,
            status: { $in: userVisibleCardStatus },
            customer
          });
          if (
            cardsOfSlug.length + (body.quantity || 1) >
            cardType.maxPerCustomer
          ) {
            throw new HttpError(400, "超过该会员卡限制购买数");
          }
        }

        if (cardType.quantity && cardType.quantity < (body.quantity || 1)) {
          throw new HttpError(400, "抱歉，该卡券已售罄");
        }

        const card = cardType.issue(customer, {
          quantity: body.quantity,
          balanceGroups: body.balanceGroups
        });

        if (body.rewardedFromBooking) {
          const booking = await BookingModel.findById(body.rewardedFromBooking);
          if (!booking) throw new HttpError(404, "Booking not found.");
          const cardRewarded = await CardModel.findOne({
            slug: cardType.slug,
            rewardedFromBooking: booking.id
          });
          if (cardRewarded) throw new HttpError(409, "该订单已经发放该种赠券");
          card.rewardedFromBooking = booking.id;
        }

        try {
          let atStore: DocumentType<Store> | null = null;
          if (query.atStore) {
            atStore = await StoreModel.findById(query.atStore);
            console.log(`[CRD] Buy card ${card.id} at store ${atStore?.code}.`);
          }

          await card.createPayment({
            paymentGateway:
              query.paymentGateway ||
              (req.ua.isWechat ? PaymentGateway.WechatPay : undefined),
            atReceptionStore:
              !req.user.can(Permission.BOOKING_ALL_STORE) &&
              card.customer?.toString() !== req.user.id
                ? req.user.store
                : atStore || undefined
          });
        } catch (err) {
          switch (err.message) {
            case "no_customer_openid":
              throw new HttpError(400, "缺少客户openid");
            case "missing_gateway":
              throw new HttpError(400, "未选择支付方式");
            default:
              throw err;
          }
        }

        if (typeof cardType.quantity === "number") {
          await CardTypeModel.updateOne(
            { _id: cardType.id },
            { $inc: { quantity: -1 } }
          );
        }

        if (card.type === "times") {
          const expiredTimesCards = await CardModel.find({
            customer: card.customer,
            stores: { $all: card.stores },
            timesLeft: { $gt: 0 },
            type: "times",
            expiresAt: { $lt: card.expiresAt },
            status: CardStatus.ACTIVATED // only activated card will be extended for now
          }).where({ end: null });

          await Promise.all(
            expiredTimesCards.map(ec => {
              ec.expiresAtWas = ec.expiresAt;
              ec.expiresAt = card.expiresAt;
              // ec.status = CardStatus.ACTIVATED;
              console.log(
                `[CRD] Customer ${
                  ec.customer
                } expired times card extends from ${moment(
                  ec.expiresAtWas
                ).format("YYYY-MM-DD HH:mm:ss")} to ${moment(
                  card.expiresAt
                ).format("YYYY-MM-DD HH:mm:ss")}.`
              );
              return ec.save();
            })
          );

          if (!card.isContract) {
            const timesCards = await CardModel.find({
              status: { $ne: CardStatus.CANCELED },
              customer: card.customer,
              type: "times",
              isContract: { $ne: true }
            });

            if (timesCards.length) {
              card.isRenewTimes = true;
            } else {
              card.isFirstTimes = true;
            }
          }
        }

        await card.save();
        await customer.save();

        res.json(card);
      })
    )

    // get all the cards
    .get(
      paginatify,
      handleAsyncErrors(async (req: Request, res: Response) => {
        const queryParams = req.query as CardQuery;
        const { limit, skip } = req.pagination;
        const query = CardModel.find();
        const sort = parseSortString(queryParams.order) || {
          createdAt: -1
        };

        (["customer", "stores", "type"] as Array<keyof CardQuery>).forEach(
          field => {
            if (queryParams[field]) {
              const value = queryParams[field] as string;
              query.find({ [field]: { $in: value.split(",") } });
            }
          }
        );

        if (queryParams.title) {
          query.find({ title: new RegExp("^" + queryParams.title) });
        }

        if (queryParams.slug) {
          query.find({ slug: new RegExp("^" + queryParams.slug) });
        }

        if (queryParams.status) {
          query.find({
            status: {
              $in: queryParams.status.split(",") as CardStatus[]
            }
          });
        } else if (!req.user.role) {
          query.find({
            status: {
              $in: [CardStatus.ACTIVATED, CardStatus.VALID]
            }
          });
        }

        // restrict self card for customers
        if (!req.user.role) {
          query.find({ customer: req.user._id });
        } else if (!req.user.can(Permission.BOOKING_ALL_STORE)) {
          query.find({ stores: { $in: [req.user.store?.id, []] } });
        }

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
    .route("/card/:cardId")

    .all(
      handleAsyncErrors(
        async (req: Request, res: Response, next: NextFunction) => {
          const card = await CardModel.findById(req.params.cardId);
          if (!card) {
            throw new HttpError(404, `Card not found: ${req.params.cardId}`);
          }
          if (!req.user.role && req.user.id !== card.customer?.toString()) {
            throw new HttpError(403);
          }
          req.item = card;
          next();
        }
      )
    )

    // get the card with that id
    .get(
      handleAsyncErrors(async (req: Request, res: Response) => {
        const card = req.item;
        res.json(card);
      })
    )

    .put(
      handleAsyncErrors(async (req: Request, res: Response) => {
        const card = req.item as DocumentType<Card>;
        const body = req.body as CardPutBody;

        const statusWas = card.status;
        card.set(body);

        if (body.expiresAt && req.user.can(Permission.CARD_SELL_ALL)) {
          // extend card expire time
          card.expiresAtWas = card.expiresAt;
          card.expiresAt = moment(card.expiresAt).endOf("day").toDate();
        }

        if (
          body.status === CardStatus.CANCELED &&
          statusWas !== CardStatus.CANCELED &&
          req.user.can(Permission.CARD_SELL_ALL)
        ) {
          try {
            const refundAmount = +req.query.refundAmount;
            if (!(refundAmount >= 0 && refundAmount <= card.price)) {
              throw new HttpError(400, "无效退款金额");
            }
            card.status = statusWas;

            if (
              card.type === "balance" &&
              card.balance &&
              card.status === CardStatus.ACTIVATED
            ) {
              const customer = await UserModel.findById(card.customer);
              if (!customer) throw new Error("invalid_customer");
              const refundBalance = customer.balanceDeposit
                ? +(
                    (refundAmount / customer.balanceDeposit) *
                    customer.balance
                  ).toFixed(2)
                : 0;
              if (
                !req.user.can(Permission.DEVELOP) &&
                ((customer.balanceDeposit || 0) < refundAmount ||
                  (customer.balance || 0) < refundBalance)
              ) {
                throw new HttpError(400, "用户余额已不足以取消本储值卡");
              }
              await customer.depositBalance(-refundBalance, -refundAmount);
            }

            await card.refund(refundAmount);
          } catch (e) {
            if (e.message === "wechat_account_insufficient_balance") {
              throw new HttpError(400, "微信商户余额不足，退款失败");
            }
            throw e;
          }
        }

        await card.save();
        res.json(card);
      })
    )

    // delete the card with this id
    .delete(
      handleAsyncErrors(async (req: Request, res: Response) => {
        if (!req.user.can(Permission.CARD_SELL_ALL)) {
          throw new HttpError(403);
        }
        const card = req.item as DocumentType<Card>;
        if (card.times !== card.timesLeft) {
          throw new HttpError(400, "次卡已使用，请撤销使用订单后再删除卡");
        }
        const usedCount = await BookingModel.countDocuments({
          card: card.id,
          status: { $in: paidBookingStatus }
        });
        if (usedCount) {
          throw new HttpError(400, "该卡已使用，请撤销订单后再删除卡");
        }
        if (
          card.type === "balance" &&
          card.balance &&
          card.status === CardStatus.ACTIVATED
        ) {
          const customer = await UserModel.findById(card.customer);
          if (!customer) throw new Error("invalid_customer");
          if (
            (card.price &&
              (!customer.balanceDeposit ||
                customer.balanceDeposit < card.price)) ||
            (card.balance &&
              (!customer.balanceReward ||
                customer.balanceReward < card.balanceReward))
          ) {
            throw new HttpError(400, "用户余额已不足以删除本储值卡");
          }
          await customer.depositBalance(-card.balance, -card.price);
        }
        await Payment.deleteMany({ card });
        await card.remove();
        res.end();
      })
    );

  return router;
};
