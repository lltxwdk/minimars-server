import {
  prop,
  getModelForClass,
  plugin,
  Ref,
  DocumentType,
  pre,
  modelOptions,
  Severity
} from "@typegoose/typegoose";
import { sign } from "jsonwebtoken";
import updateTimes from "./plugins/updateTimes";
import { Booking } from "./Booking";
import UserModel, { User } from "./User";
import { Store } from "./Store";
import PaymentModel, { PaymentGateway, Payment, Scene } from "./Payment";
import autoPopulate from "./plugins/autoPopulate";
import HttpError from "../utils/HttpError";
import {
  appendResizeImageUrl,
  removeResizeImageUrl
} from "../utils/imageResize";

const { DEBUG } = process.env;

export enum CardStatus {
  PENDING = "pending", // pending payment for the card
  VALID = "valid", // paid gift card before activated
  ACTIVATED = "activated", // paid non-gift card / activated gift card
  EXPIRED = "expired", // expired period, times empty, credit deposit to user
  CANCELED = "canceled" // never used and will never be activated
}

export const userVisibleCardStatus = [
  CardStatus.VALID,
  CardStatus.ACTIVATED,
  CardStatus.EXPIRED
];

export class BalanceGroup {
  @prop({ type: Number, required: true })
  balance!: number;

  @prop({ type: Number, default: 1 })
  count = 1;
}

@plugin(updateTimes)
@plugin(autoPopulate, [
  {
    path: "payments",
    options: { sort: { _id: -1 } },
    select: "-customer"
  }
])
@pre("save", async function (this: DocumentType<Card>, next) {
  if (["times", "coupon", "period"].includes(this.type)) {
    if (
      this.status === CardStatus.ACTIVATED &&
      (this.timesLeft === 0 || (this.expiresAt && this.expiresAt < new Date()))
    ) {
      this.status = CardStatus.EXPIRED;
    } else if (
      this.status === CardStatus.EXPIRED &&
      ((this.timesLeft &&
        this.timesLeft > 0 &&
        (!this.expiresAt || this.expiresAt >= new Date())) ||
        (this.type === "period" &&
          this.expiresAt &&
          this.expiresAt >= new Date()))
    ) {
      this.status = CardStatus.ACTIVATED;
    }
  }
  if (
    this.type === "balance" &&
    this.isModified("status") &&
    this.status === CardStatus.ACTIVATED &&
    this.balance !== undefined
  ) {
    if (!this.populated("customer")) {
      await this.populate("customer").execPopulate();
    }
    const customer = this.customer as DocumentType<User>;
    await customer.depositBalance(this.balance, this.price);
    console.log(
      `[CRD] Balance card ${this.id} deposit user ${customer.id} by ${
        this.balance - this.price
      }/${this.price}`
    );
  }
  next();
})
@modelOptions({ options: { allowMixed: Severity.ALLOW } })
export class Card {
  @prop({ ref: "User", required: true, index: true })
  customer: Ref<User>;

  @prop({ type: Number })
  timesLeft?: number;

  @prop({ type: String })
  num?: string;

  @prop({ type: Number })
  quantity?: number;

  @prop({ type: BalanceGroup })
  balanceGroups?: BalanceGroup[];

  @prop({
    type: String,
    enum: Object.values(CardStatus),
    default: CardStatus.PENDING
  })
  status: CardStatus = CardStatus.PENDING;

  @prop({ type: Boolean })
  isRenewTimes?: boolean;

  @prop({
    ref: "Payment",
    foreignField: "card",
    localField: "_id"
  })
  payments!: DocumentType<Payment>[];

  @prop({ type: Date })
  expiresAt?: Date;

  @prop({ type: Date })
  expiresAtWas?: Date;

  // properties from cardType
  @prop({ type: String, required: true })
  title!: string;

  @prop({ type: String })
  slug?: string;

  @prop({
    type: String,
    enum: ["times", "period", "balance", "coupon", "partner"],
    required: true
  })
  type!: "times" | "period" | "balance" | "coupon" | "partner";

  @prop({ type: Number, required: true })
  price!: number;

  @prop({ ref: "Store" })
  stores!: Ref<Store>[];

  @prop({ type: Date })
  start?: Date;

  @prop({ type: Date })
  end?: Date;

  @prop()
  dayType?: "onDaysOnly" | "offDaysOnly";

  @prop({ type: Boolean })
  isGift?: boolean;

  @prop({ type: Boolean })
  isContract?: boolean;

  @prop({
    get: v => appendResizeImageUrl(v),
    set: v => removeResizeImageUrl(v)
  })
  posterUrl?: string;

  @prop({
    get: v => appendResizeImageUrl(v),
    set: v => removeResizeImageUrl(v)
  })
  posterDenseUrl?: string;

  @prop()
  content?: string;

  @prop()
  couponSlug?: string;

  @prop()
  rewardCardTypes?: string;

  // type-related properties below
  @prop({ type: Number })
  times?: number;

  @prop({ type: Number })
  balance?: number;

  @prop({ type: Number })
  maxKids?: number;

  @prop({ type: Number })
  minKids?: number;

  @prop({ type: Number })
  freeParentsPerKid?: number;

  @prop({ type: Number })
  overPrice?: number;

  @prop({ type: Number })
  discountPrice?: number;

  @prop({ type: Number })
  discountRate?: number;

  @prop({ type: Number })
  fixedPrice?: number;

  @prop()
  partnerUrl?: string;

  @prop({ type: Boolean })
  cardsRewarded?: boolean;

  @prop({ ref: "Booking" })
  rewardedFromBooking?: Ref<Booking>;

  @prop({ type: Object })
  providerData?: Record<string, any>;

  get giftCode(): string | undefined {
    const card = this as unknown as DocumentType<Card>;
    if (!card.isGift || card.status !== CardStatus.VALID) return undefined;
    const code = sign(
      card.customer + " " + card.id,
      process.env.APP_SECRET || ""
    );
    // console.log("Hash giftCode:", card.customer, card.id, code);
    return code;
  }

  get balanceReward(): number {
    if (this.balance === undefined) return NaN;
    return +(this.balance - this.price).toFixed(2);
  }

  async createPayment(
    this: DocumentType<Card>,
    {
      paymentGateway,
      atReceptionStore = undefined
    }: {
      paymentGateway?: PaymentGateway;
      atReceptionStore?: DocumentType<Store>;
    },
    amount?: number
  ) {
    const card = this as DocumentType<Card>;
    let totalPayAmount = +card.price.toFixed(2);
    let attach = `card ${card.id}`;
    let title = `${card.title}`;

    if (card.quantity && card.quantity > 1) {
      title = title + "×" + card.quantity;
    }

    if (totalPayAmount < 0) throw new Error("total_payment_amount_error");

    if (!totalPayAmount) {
      await card.paymentSuccess();
    } else {
      const scene =
        paymentGateway === PaymentGateway.Mall ||
        (card.stores.length !== 1 && !atReceptionStore)
          ? Scene.MALL
          : card.type === "balance"
          ? Scene.BALANCE
          : card.type === "period"
          ? Scene.PERIOD
          : Scene.CARD;
      const payment = new PaymentModel({
        scene,
        customer: card.customer,
        store:
          atReceptionStore?.id ||
          (card.stores.length === 1 ? card.stores[0] : undefined),
        amount:
          amount === undefined
            ? DEBUG
              ? totalPayAmount / 1e4
              : totalPayAmount
            : amount,
        title,
        attach,
        card: card.id,
        gateway: paymentGateway
      });

      if (card.times !== undefined) {
        payment.times = card.times;
      }

      await payment.save();

      if (paymentGateway !== PaymentGateway.WechatPay) {
        await card.paymentSuccess();
      }
    }
  }

  async paymentSuccess(this: DocumentType<Card>) {
    this.status = this.isGift ? CardStatus.VALID : CardStatus.ACTIVATED;
    console.log(`[CRD] Card ${this.id} payment success.`);
    // send user notification
  }

  async createRefundPayment(
    this: DocumentType<Card>,
    totalRefundAmount?: number
  ) {
    // card.payments[].customer is unselected from auto-populating,
    // but payment pre-save needs it, so we re populate full payments
    await this.populate("payments").execPopulate();

    let amountToRefund = totalRefundAmount || this.price;
    for (const p of this.payments) {
      if (
        ![Scene.CARD, Scene.BALANCE, Scene.MALL, Scene.PERIOD].includes(p.scene)
      ) {
        continue;
      }
      const refundAmount = Math.min(amountToRefund, p.amount);

      amountToRefund = +(amountToRefund - refundAmount).toFixed(2);

      const card = await CardModel.findById(p.card);
      if (!card) throw new Error("invalid_card");

      const debt =
        card.timesLeft !== undefined && card.times
          ? -((card.timesLeft / card.times) * card.price).toFixed(8)
          : -card.price;

      // refund payment by refundAmount
      const refundPayment = new PaymentModel({
        scene: p.scene,
        customer: p.customer,
        store: p.store,
        amount: -refundAmount,
        assets: -refundAmount,
        debt,
        revenue: -(refundAmount + debt).toFixed(8),
        title: `退款：${p.title}`,
        card: p.card,
        times: card.timesLeft !== undefined ? -card.timesLeft : undefined,
        gateway: p.gateway,
        original: p.id
      });
      p.refunded = true;
      await p.save();
      await refundPayment.save();
    }

    this.refundSuccess();
  }

  async refundSuccess(this: DocumentType<Card>) {
    this.status = CardStatus.CANCELED;
    console.log(`[CRD] Refund success ${this.id}.`);
    if (this.timesLeft) {
      this.timesLeft = 0;
    }
    // send user notification
  }

  async refund(this: DocumentType<Card>, refundAmount: number) {
    if (this.status === CardStatus.CANCELED) {
      return;
    }

    if (this.payments.filter(p => p.paid).length) {
      console.log(`[CRD] Refund ${this.id}.`);
      // we don't directly change status to canceled, will auto change on refund fullfil
      await this.createRefundPayment(refundAmount);
      if (!this.payments.filter(p => p.amount < 0).some(p => !p.paid)) {
        this.refundSuccess();
      }
    } else {
      this.refundSuccess();
    }

    if (this.type === "balance" && this.status === CardStatus.ACTIVATED) {
      const customer = await UserModel.findById(this.customer);
      if (
        (customer?.balanceDeposit || 0) < this.price ||
        (customer?.balanceReward || 0) < this.balanceReward
      ) {
        throw new HttpError(400, "用户余额已不足以退款本储值卡");
      }
      await customer?.depositBalance(-(this.balance || 0), -this.price);
    }

    console.log(`[CRD] Cancel card ${this.id}.`);

    await this.save();
  }
}

const CardModel = getModelForClass(Card, {
  schemaOptions: {
    toJSON: {
      getters: true,
      transform: function (doc, ret, options) {
        delete ret._id;
        delete ret.__v;
      }
    }
  }
});

export default CardModel;
