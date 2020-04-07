import {
  prop,
  getModelForClass,
  plugin,
  pre,
  Ref,
  DocumentType
} from "@typegoose/typegoose";
import updateTimes from "./plugins/updateTimes";
import autoPopulate from "./plugins/autoPopulate";
import { User } from "./User";
import Booking from "./Booking";
import {
  unifiedOrder as wechatUnifiedOrder,
  payArgs as wechatPayArgs
} from "../utils/wechat";
import cardModel, { Card, CardStatus } from "./Card";

@pre("save", async function(next) {
  const payment = this as DocumentType<Payment>;

  if (!payment.isModified("paid") && !payment.isNew) {
    return next();
  }

  console.log(`[PAY] Payment pre save ${payment._id}.`);

  if (payment.paid) {
    payment.paidSuccess();
    return next();
  }

  await payment.populate("customer").execPopulate();

  const customer = payment.customer as DocumentType<User>;

  switch (payment.gateway) {
    case PaymentGateway.WechatPay:
      if (payment.gatewayData) return next();
      await payment.populate("customer").execPopulate();
      if (!customer.openid) {
        throw new Error("no_customer_openid");
      }
      payment.gatewayData = await wechatUnifiedOrder(
        payment._id.toString(),
        payment.amount,
        customer.openid,
        payment.title,
        payment.attach
      );
      break;
    case PaymentGateway.Balance:
      if (customer.balance < payment.amount) {
        throw new Error("insufficient_balance");
      }

      console.log(
        `[PAY] D:R was ${customer.balanceDeposit}:${customer.balanceReward}.`
      );

      if (!payment.amountForceDeposit) {
        payment.amountForceDeposit = 0;
      }

      const depositPaymentAmount =
        payment.amountDeposit ||
        Math.max(
          +(
            payment.amountForceDeposit +
            ((payment.amount - payment.amountForceDeposit) *
              customer.balanceDeposit) /
              customer.balance
          ).toFixed(2),
          0.01
        );

      const rewardPaymentAmount = +(
        payment.amount - depositPaymentAmount
      ).toFixed(2);

      console.log(
        `[PAY] Payment amount D:R is ${depositPaymentAmount}:${rewardPaymentAmount}.`
      );

      customer.balanceDeposit -= depositPaymentAmount;
      customer.balanceReward -= rewardPaymentAmount;
      payment.amountDeposit = depositPaymentAmount;

      console.log(
        `[DEBUG] Balance payment saved, customer balance is now ${customer.balance}`
      );

      payment.paid = true;
      // await payment.paidSuccess();
      // we don't trigger paidSuccess or booking.paidSuccess here cause booking may not be saved
      // we need to change booking status manually after balance payment
      await customer.save();
      break;
    case PaymentGateway.Card:
      if (
        !payment.gatewayData ||
        !payment.gatewayData.bookingId ||
        !payment.gatewayData.cardId ||
        !payment.gatewayData.times
      ) {
        throw new Error("invalid_card_payment_gateway_data");
      }
      const card = await cardModel.findOne({ _id: payment.gatewayData.cardId });

      if (payment.gatewayData.cardRefund) {
        card.timesLeft += payment.gatewayData.times;
        await card.save();
        // await customer.updateCardBalance();
        console.log(
          `[PAY] Card ${card.id} refunded, time left: ${card.timesLeft}.`
        );
        payment.paid = true;
      } else {
        if (card.status !== CardStatus.ACTIVATED) {
          throw new Error("invalid_card");
        }
        if (card.timesLeft < payment.gatewayData.times) {
          throw new Error("insufficient_card_times");
        }
        card.timesLeft -= payment.gatewayData.times;
        await card.save();
        // await customer.updateCardBalance();
        console.log(
          `[PAY] Card ${card.id} used in ${payment.gatewayData.bookingId}, times left: ${card.timesLeft}.`
        );
        payment.paid = true;
      }

      break;
    case PaymentGateway.Scan:
      break;
    case PaymentGateway.Cash:
      break;
    case PaymentGateway.Points:
      if (payment.amountInPoints > customer.points) {
        throw new Error("insufficient_points");
      }
      customer.points -= payment.amountInPoints;
      await customer.save();
      payment.paid = true;
      break;
    default:
      throw new Error("unsupported_payment_gateway");
  }
  next();
})
@plugin(autoPopulate, [{ path: "customer", select: "name avatarUrl mobile" }])
@plugin(updateTimes)
export class Payment {
  @prop({ ref: "User", required: true })
  customer: DocumentType<User>;

  @prop({ required: true })
  amount: number;

  @prop()
  amountForceDeposit?: number;

  @prop()
  amountDeposit?: number;

  @prop()
  amountInPoints?: number;

  @prop({ default: false })
  paid: boolean;

  @prop({ default: " " })
  title: string;

  @prop({ type: String })
  attach: string;

  @prop({ required: true })
  gateway: PaymentGateway;

  @prop()
  gatewayData: { [key: string]: any };

  @prop()
  original?: string;

  get payArgs(this: DocumentType<Payment>) {
    const payment = this;
    if (payment.gateway === PaymentGateway.WechatPay && !payment.paid) {
      if (
        !payment.gatewayData ||
        !payment.gatewayData.nonce_str ||
        !payment.gatewayData.prepay_id
      ) {
        if (payment.isNew) return;
        else throw new Error(`incomplete_gateway_data`);
      }
      const wechatGatewayData = payment.gatewayData as {
        nonce_str: string;
        prepay_id: string;
      };
      return wechatPayArgs(wechatGatewayData);
    }
  }
  async paidSuccess(this: DocumentType<Payment>) {
    const payment = this;

    const paymentAttach = payment.attach.split(" ");

    switch (paymentAttach[0]) {
      case "booking":
        const booking = await Booking.findOne({ _id: paymentAttach[1] });
        if (payment.amount >= 0) {
          await booking.paymentSuccess();
          console.log(`[PAY] Booking payment success, id: ${booking._id}.`);
        } else {
          await booking.refundSuccess();
          console.log(`[PAY] Booking refund success, id: ${booking._id}.`);
        }
        break;
      case "card":
        const card = await cardModel.findOne({ _id: paymentAttach[1] });
        await card.paymentSuccess();
        console.log(`[PAY] Card purchase success, id: ${card._id}.`);
        break;
      default:
        console.error(
          `[PAY] Unknown payment attach: ${JSON.stringify(payment.attach)}`
        );
    }
  }
}

export enum PaymentGateway {
  Balance = "balance",
  Points = "points",
  Card = "card",
  Coupon = "coupon",
  Scan = "scan",
  Cash = "cash",
  WechatPay = "wechatpay",
  Alipay = "alipay",
  UnionPay = "unionpay"
}

export const gatewayNames = {
  [PaymentGateway.Balance]: "账户余额",
  [PaymentGateway.Points]: "账户积分",
  [PaymentGateway.Coupon]: "团购优惠券",
  [PaymentGateway.Scan]: "现场扫码",
  [PaymentGateway.Card]: "会员卡",
  [PaymentGateway.Cash]: "现金刷卡",
  [PaymentGateway.WechatPay]: "微信小程序",
  [PaymentGateway.Alipay]: "支付宝",
  [PaymentGateway.UnionPay]: "银联"
};

const paymentModel = getModelForClass(Payment, {
  schemaOptions: {
    toJSON: {
      getters: true,
      transform: function(doc, ret, options) {
        delete ret._id;
        delete ret.__v;
      }
    }
  }
});

export default paymentModel;
