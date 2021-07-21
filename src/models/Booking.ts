import {
  prop,
  getModelForClass,
  plugin,
  DocumentType,
  modelOptions,
  Severity,
  pre
} from "@typegoose/typegoose";
import moment from "moment";
import updateTimes from "./plugins/updateTimes";
import autoPopulate from "./plugins/autoPopulate";
import { config } from "../models/Config";
import PaymentModel, { Payment, PaymentGateway, Scene } from "./Payment";
import UserModel, { User } from "./User";
import { storeMap, Store } from "./Store";
import { Card } from "./Card";
import { Event } from "./Event";
import { Gift } from "./Gift";
import { Coupon } from "./Coupon";
import { sendTemplateMessage, TemplateMessageType } from "../utils/wechat";
import CardTypeModel from "./CardType";
import HttpError from "../utils/HttpError";
import Pospal, { ProductInCustomerMenu } from "../utils/pospal";
import { TimeStamps } from "@typegoose/typegoose/lib/defaultClasses";

const { DEBUG } = process.env;

export enum BookingStatus {
  PENDING = "pending",
  BOOKED = "booked",
  IN_SERVICE = "in_service",
  PENDING_REFUND = "pending_refund",
  FINISHED = "finished",
  CANCELED = "canceled"
}

export const liveBookingStatus = [
  BookingStatus.PENDING,
  BookingStatus.BOOKED,
  BookingStatus.IN_SERVICE
];

export const deadBookingStatus = [
  BookingStatus.FINISHED,
  BookingStatus.CANCELED
];

export const paidBookingStatus = [
  BookingStatus.BOOKED,
  BookingStatus.IN_SERVICE,
  BookingStatus.PENDING_REFUND,
  BookingStatus.FINISHED
];

export const validBookingStatus = [
  BookingStatus.PENDING,
  BookingStatus.BOOKED,
  BookingStatus.IN_SERVICE,
  BookingStatus.FINISHED
];

export class BookingPrice {
  price = 0;
  priceInPoints?: number;
  coupon?: Coupon;
}

type Amounts = Required<
  Pick<
    Booking,
    | "amountPaid"
    | "amountPaidInBalance"
    | "amountPaidInDeposit"
    | "amountPaidInCard"
    | "amountPaidInPoints"
  >
>;

class FoodItem {
  @prop({ type: String, required: true })
  productUid!: string;

  @prop({ type: Number, default: 1 })
  quantity = 1;

  @prop({ type: String })
  productCategory?: string;

  @prop({ type: String })
  productName?: string;

  @prop({ type: String })
  productImageUrl?: string;
}

@plugin(autoPopulate, [
  {
    path: "customer",
    select:
      "name avatarUrl mobile tags points balanceDeposit balanceReward openidMp"
  },
  {
    path: "store",
    select: "name code kidFullDayPrice extraParentFullDayPrice"
  },
  { path: "payments", options: { sort: { _id: -1 } }, select: "-customer" },
  { path: "card", select: "-content" },
  { path: "coupon", select: "-content" },
  { path: "event", select: "-content" },
  { path: "gift", select: "-content" }
])
@plugin(updateTimes)
// @index({ date: 1, checkInAt: 1, customer: 1 }, { unique: true })
@modelOptions({ options: { allowMixed: Severity.ALLOW } })
@pre("validate", function (this: DocumentType<Booking>) {
  if (this.type === Scene.FOOD && this.items) {
    const store = storeMap[this.store?.id || ""];
    if (!store || !store.foodMenu)
      throw new Error("invalid_food_booking_store_menu");
    const menu = store.foodMenu;
    this.items.forEach(item => {
      const matchCategory = menu.find(cat => {
        const product = cat.products.find(p => p.uid === item.productUid);
        if (product) {
          item.productName = product.name;
          item.productImageUrl = product.imageUrl;
          item.productCategory = cat.name;
          return true;
        }
        return false;
      });
      if (!matchCategory) {
        throw new HttpError(404, `未找到餐品编号：${item.productUid}`);
      }
    });
  }
})
export class Booking extends TimeStamps {
  @prop({ ref: "User" })
  customer?: DocumentType<User>;

  @prop({ ref: "Store" })
  store?: DocumentType<Store>;

  @prop({ enum: Object.values(Scene), required: true })
  type!: Scene;

  @prop({ required: true })
  date!: string;

  @prop({ required: true })
  checkInAt!: string;

  @prop()
  checkOutAt?: string;

  @prop({ type: Number })
  adultsCount?: number;

  @prop({ type: Number })
  kidsCount?: number;

  @prop({ type: Number })
  socksCount?: number;

  @prop({ type: Number })
  bandsPrinted?: number;

  @prop({ type: String })
  photos?: string[];

  @prop({ type: String })
  faces?: string[];

  @prop({
    type: String,
    enum: Object.values(BookingStatus),
    default: BookingStatus.PENDING
  })
  status: BookingStatus = BookingStatus.PENDING;

  @prop({
    type: String,
    enum: Object.values(BookingStatus)
  })
  statusWas?: BookingStatus;

  @prop({ type: Number })
  price?: number;

  @prop({ type: Number })
  amountPaid?: number;

  @prop({ type: Number })
  amountPaidInBalance?: number;

  @prop({ type: Number })
  amountPaidInDeposit?: number;

  @prop({ type: Number })
  amountPaidInCard?: number;

  @prop({ type: Number })
  amountPaidInPoints?: number;

  @prop({ ref: "Card" })
  card?: DocumentType<Card>;

  @prop({ ref: "Coupon" })
  coupon?: DocumentType<Coupon>;

  @prop({ ref: "Event" })
  event?: DocumentType<Event>;

  @prop({ ref: "Gift" })
  gift?: DocumentType<Gift>;

  @prop({ type: Number }) // quantity of gifts
  quantity?: number;

  @prop({
    ref: "Payment",
    foreignField: "booking",
    localField: "_id"
  })
  payments!: DocumentType<Payment>[];

  @prop()
  remarks?: string;

  @prop({ type: Object })
  providerData?: Record<string, any>;

  @prop({ type: String })
  tableId?: string;

  @prop({ type: FoodItem })
  items?: FoodItem[];

  get title() {
    let title = "";

    if (this.type === Scene.GIFT) {
      if (!this.gift) throw new Error("undefined_gift");
      title = `${this.gift.title} ${this.quantity}份 ${
        this.store?.name || "门店通用"
      } `;
    } else if (this.type === Scene.EVENT) {
      if (!this.event || !this.store) throw new Error("undefined_event_store");
      title = `${this.event.title} ${this.kidsCount}人 ${this.store.name} `;
    } else if (this.type === Scene.PARTY) {
      title = "派对消费";
    } else if (this.type === Scene.FOOD) {
      title = "餐饮消费";
    } else if (this.type === Scene.MALL) {
      title = this.remarks || "";
    } else {
      if (!this.store) throw new Error("undefined_play_store");
      title = `${this.store.name} ${this.adultsCount}大${
        this.kidsCount
      }小 ${this.date.substr(5)} ${this.checkInAt.substr(0, 5)}前入场`;
    }

    return title;
  }

  async calculatePrice(this: DocumentType<Booking>): Promise<BookingPrice> {
    const bookingPrice = new BookingPrice();

    if (!this.populated("customer")) {
      await this.populate("customer").execPopulate();
    }

    if (this.type === "play") {
      const kidFullDayPrice =
        this.store?.kidFullDayPrice || config.kidFullDayPrice;
      const extraParentFullDayPrice =
        this.store?.extraParentFullDayPrice || config.extraParentFullDayPrice;
      const freeParentsPerKid =
        this.store?.freeParentsPerKid || config.freeParentsPerKid;
      if (
        this.adultsCount === undefined ||
        this.kidsCount === undefined ||
        freeParentsPerKid === undefined ||
        extraParentFullDayPrice === undefined ||
        kidFullDayPrice === undefined
      ) {
        throw new Error("undefined_play_params");
      }
      let kidsCount = this.kidsCount;
      let extraAdultsCount = Math.max(
        0,
        this.adultsCount - this.kidsCount * freeParentsPerKid
      );

      if (this.card) {
        if (!this.populated("card")) {
          await this.populate("card").execPopulate();
        }
        if (
          this.card.type === "coupon" &&
          (!this.card.overPrice || bookingPrice.price >= this.card.overPrice)
        ) {
          if (this.card.discountPrice) {
            bookingPrice.price -= this.card.discountPrice;
          } else if (this.card.discountRate) {
            bookingPrice.price =
              bookingPrice.price * (1 - this.card.discountRate);
          }
        } else if (this.card.type === "coupon" && this.card.fixedPrice) {
          bookingPrice.price = this.card.fixedPrice;
        } else if (this.card.type === "balance") {
          this.card = undefined;
        } else if (
          this.card.maxKids === undefined ||
          this.card.freeParentsPerKid === undefined
        ) {
          throw new Error("invalid_card");
        } else {
          kidsCount = Math.max(0, this.kidsCount - this.card.maxKids);
          extraAdultsCount = Math.max(
            0,
            this.adultsCount -
              (this.kidsCount - kidsCount) * this.card.freeParentsPerKid -
              kidsCount * freeParentsPerKid
          );
        }
        // TODO check card valid times
        // TODO check card valid period
      }

      if (this.coupon) {
        if (!this.populated("coupon")) {
          await this.populate("coupon").execPopulate();
        }
        if (!this.coupon) {
          throw new Error("coupon_not_found");
        }
        kidsCount = 0;
        extraAdultsCount = Math.max(
          0,
          this.adultsCount - this.kidsCount * this.coupon.freeParentsPerKid
        );
        if (this.coupon.kidsCount === 0) {
          // adults only coupon
          extraAdultsCount = 0;
        }
      }

      bookingPrice.price =
        extraParentFullDayPrice * extraAdultsCount +
        kidFullDayPrice * kidsCount;

      if (this.coupon && this.coupon.price) {
        bookingPrice.price += this.coupon.price * this.kidsCount;
      }

      if (config.sockPrice && this.socksCount) {
        bookingPrice.price += this.socksCount * config.sockPrice;
      }
      bookingPrice.price = +bookingPrice.price.toFixed(2);
    } else if (this.type === "event") {
      if (this.kidsCount === undefined) {
        throw new Error("undefined_event_kids_count");
      }
      if (!this.populated("event")) {
        await this.populate({
          path: "event",
          select: "-content"
        }).execPopulate();
      }
      if (!this.event) {
        return bookingPrice;
        // throw new Error("invalid_event");
      }
      if (this.event.priceInPoints) {
        bookingPrice.priceInPoints = this.event.priceInPoints * this.kidsCount;
      }
      if (this.event.price) {
        bookingPrice.price = this.event.price * this.kidsCount;
      }
    } else if (this.type === "gift") {
      if (this.quantity === undefined) {
        this.quantity = 1;
      }
      if (!this.populated("gift")) {
        await this.populate("gift").execPopulate();
      }
      if (!this.gift) {
        return bookingPrice;
        // throw new Error("invalid_gift");
      }
      if (this.gift.priceInPoints) {
        bookingPrice.priceInPoints = this.gift.priceInPoints * this.quantity;
      }
      if (this.gift.price) {
        bookingPrice.price = this.gift.price * this.quantity;
      }
    } else if (this.type === "food") {
      if (!this.store) throw new Error("food_booking_missing_store");
      const store = storeMap[this.store.id];
      const menu = store.foodMenu;
      if (!menu) throw new Error("food_menu_missing");
      const products = menu.reduce(
        (products, category) => products.concat(category.products),
        [] as ProductInCustomerMenu[]
      );
      if (this.items) {
        for (const item of this.items) {
          const product = products.find(p => p.uid === item.productUid);
          if (!product) throw new Error("food_product_not_found");
          bookingPrice.price = +(
            bookingPrice.price + product.sellPrice
          ).toFixed(10);
        }
      }
      if (this.card && !this.populated("card")) {
        await this.populate("card").execPopulate();
        if (this.price) {
          bookingPrice.price = this.price;
        }
        if (
          this.card.type === "coupon" &&
          (!this.card.overPrice || bookingPrice.price >= this.card.overPrice)
        ) {
          if (this.card.discountPrice) {
            bookingPrice.price -= this.card.discountPrice;
          } else if (this.card.discountRate) {
            bookingPrice.price =
              bookingPrice.price * (1 - this.card.discountRate);
          }
        }
        if (this.card.type === "coupon" && this.card.fixedPrice) {
          bookingPrice.price = this.card.fixedPrice;
        }
        if (this.tableId && this.items) {
          bookingPrice.price = 0.02;
        }
      }
    } else if (this.type === "party") {
      if (this.price) {
        bookingPrice.price = this.price;
      }
    } else {
      throw new Error();
    }

    return bookingPrice;
  }

  async createPayment(
    this: DocumentType<Booking>,
    {
      paymentGateway,
      useBalance = true,
      atReception = false
    }: {
      paymentGateway?: PaymentGateway;
      useBalance?: boolean;
      atReception?: boolean;
    },
    amount: number,
    amountInPoints?: number
  ) {
    const totalPayAmount = +amount.toFixed(2);
    let balancePayAmount = 0;
    let attach = `booking ${this._id}`;
    if (!atReception) {
      if (
        this.card?.start &&
        new Date(this.card.start) > moment(this.date).endOf("day").toDate()
      ) {
        throw new Error("card_not_started");
      }
      const cardExpiresAt = this.card?.expiresAt || this.card?.end;
      if (
        cardExpiresAt &&
        new Date(cardExpiresAt) < moment(this.date).startOf("day").toDate()
      ) {
        throw new Error("card_expired");
      }
    }
    if (this.card && ["times", "coupon"].includes(this.card.type)) {
      if (this.card.times === undefined)
        throw new Error("invalid_times_coupon_card");
      const cardTimes = this.card.maxKids
        ? Math.min(this.kidsCount || 1, this.card.maxKids)
        : this.kidsCount || 1;
      const cardPayment = new PaymentModel({
        scene: this.type,
        customer: this.customer,
        store: this.store,
        amount: (this.card.price / this.card.times) * cardTimes,
        title: this.title,
        attach,
        booking: this.id,
        card: this.card.id,
        gateway: this.card.isContract
          ? PaymentGateway.Contract
          : PaymentGateway.Card,
        times: -cardTimes,
        gatewayData: {
          atReception,
          cardId: this.card.id,
          cardTitle: this.card.title,
          timesBefore: this.card.timesLeft
        }
      });
      await cardPayment.save();
      this.payments.push(cardPayment);
    }

    if (this.coupon) {
      if (
        (this.kidsCount || 0) % this.coupon.kidsCount ||
        (!this.coupon.kidsCount && this.kidsCount)
      ) {
        throw new Error("coupon_kids_count_not_match");
      }
      const couponPayment = new PaymentModel({
        scene: this.type,
        customer: this.customer,
        store: this.store,
        amount:
          (this.coupon.priceThirdParty *
            (this.kidsCount || this.adultsCount || 1)) /
          (this.coupon.kidsCount || 1),
        title: this.coupon.title + " " + this.title,
        attach,
        booking: this.id,
        gateway: PaymentGateway.Coupon,
        gatewayData: {
          atReception,
          couponId: this.coupon.id,
          couponTitle: this.coupon.title,
          bookingId: this.id
        }
      });
      await couponPayment.save();
      this.payments.push(couponPayment);
    }
    if (totalPayAmount && useBalance && this.customer?.balance) {
      balancePayAmount = Math.min(totalPayAmount, this.customer.balance);
      const balancePayment = new PaymentModel({
        scene: this.type,
        customer: this.customer,
        store: this.store,
        amount: balancePayAmount,
        amountForceDeposit:
          (this.socksCount || 0) * (config.sockPrice || 0) || 0,
        title: this.title,
        attach,
        booking: this.id,
        gateway: PaymentGateway.Balance,
        gatewayData: {
          atReception,
          balanceBefore: this.customer.balance,
          balanceDepositBefore: this.customer.balanceDeposit
        }
      });

      await balancePayment.save();
      this.payments.push(balancePayment);
    }

    const extraPayAmount = +(totalPayAmount - balancePayAmount).toFixed(2);
    // console.log(`[PAY] Extra payment amount is ${extraPayAmount}`);

    if (extraPayAmount < 0) throw new Error("booking_payment_amount_overflow");

    if (paymentGateway === PaymentGateway.Points) {
      if (amountInPoints === undefined) {
        throw new HttpError(400, "不支持积分支付");
      }
      const pointsPayment = new PaymentModel({
        scene: this.type,
        customer: this.customer,
        store: this.store,
        amount: 0,
        amountInPoints,
        title: this.title,
        attach,
        booking: this.id,
        gateway: PaymentGateway.Points,
        gatewayData: {
          atReception
        }
      });

      await pointsPayment.save();
      this.payments.push(pointsPayment);
      await this.paymentSuccess(atReception);
    } else if (!extraPayAmount) {
      await this.paymentSuccess(atReception);
    } else {
      if (!paymentGateway) {
        throw new Error("missing_gateway");
      }

      const extraPayment = new PaymentModel({
        scene: this.type,
        customer: this.customer,
        store: this.store?.id,
        amount: extraPayAmount,
        title: this.title,
        attach,
        booking: this.id,
        gateway: paymentGateway,
        gatewayData: {
          atReception
        }
      });

      await extraPayment.save();
      this.payments.push(extraPayment);

      if (paymentGateway !== PaymentGateway.WechatPay) {
        await this.paymentSuccess(atReception);
      }
    }

    if (paymentGateway === PaymentGateway.Points && !amountInPoints) {
      throw new Error("points_gateway_not_supported");
    }

    // we give up save all payments at the same time. It saves no time but cause a user parallel saving problem
  }

  async paymentSuccess(this: DocumentType<Booking>, atReception = false) {
    // conditional change booking status
    if (this.type === Scene.FOOD) {
      if (!this.tableId || process.env.DISABLE_FOOD_ONLINE_ORDER) {
        this.status = BookingStatus.FINISHED;
      } else {
        if (!this.store) throw new Error("food_booking_missing_store");
        try {
          const res = (await new Pospal(this.store.code).addOnlineOrder(
            this
          )) as unknown as {
            orderNo: string;
            orderCreateDateTime: string;
            customerNumber: string;
          };
          this.status = BookingStatus.IN_SERVICE;
          this.providerData = {
            provider: "pospal",
            sn: res.orderNo
          };
        } catch (e) {
          console.log(`[BOK] Error create food order, cancel...`);
          await this.cancel();
          throw new HttpError(400, "点餐下单发生错误，资金已原路退回");
        }
      }
    } else if ([Scene.GIFT, Scene.EVENT].includes(this.type)) {
      this.status = atReception ? BookingStatus.FINISHED : BookingStatus.BOOKED;
    } else if (this.date === moment().format("YYYY-MM-DD") && atReception) {
      await this.checkIn();
    } else {
      this.status = BookingStatus.BOOKED;
    }

    console.log(`[BOK] Payment success ${this.id}, status: ${this.status}.`);

    if (this.type === Scene.EVENT) {
      if (!this.populated("event")) {
        await this.populate({
          path: "event",
          select: "-content"
        }).execPopulate();
      }
      if (!this.event || !this.kidsCount) {
        throw new Error("invalid_event");
      }
      if (this.event.kidsCountMax && this.event.kidsCountLeft) {
        this.event.kidsCountLeft -= this.kidsCount;
        console.log(
          `[BOK] Event ${this.event.id} kids left ${this.event.kidsCountLeft}, ${this.kidsCount} occupied by booking ${this.id}.`
        );
        await this.event.save();
      }
    } else if (this.type === Scene.GIFT) {
      if (!this.populated("gift")) {
        await this.populate("gift").execPopulate();
      }
      if (!this.gift || !this.quantity) {
        throw new Error("invalid_gift");
      }
      if (this.gift.quantity !== undefined && this.gift.quantity !== null) {
        this.gift.quantity -= this.quantity;
        console.log(
          `[BOK] Gift ${this.gift.id} quantity left ${this.gift.quantity}, ${this.quantity} occupied by booking ${this.id}.`
        );
        await this.gift.save();
      }
      if (this.gift.isProfileCover) {
        if (this.customer) {
          this.customer.covers.push(this.gift);
          this.customer.currentCover = this.gift;
          await this.customer.save();
        }
      }
    }

    if (!this.populated("customer")) {
      await this.populate("customer").execPopulate();
    }

    if (this.gift && this.gift.tagCustomer && this.customer) {
      if (!this.customer.tags.includes(this.gift.tagCustomer)) {
        this.customer.tags.push(this.gift.tagCustomer);
        await this.customer.save();
      }
    }

    const amountPaidNoCoupon = this.payments.reduce((amount, p) => {
      if (p.paid && p.gateway !== PaymentGateway.Coupon) {
        amount += p.amount;
      }
      return amount;
    }, 0);

    await this.customer?.addPoints(amountPaidNoCoupon);

    // send user notification
  }

  async createRefundPayment(this: DocumentType<Booking>) {
    // booking.payments[].customer is unselected from auto-populating,
    // but payment pre-save needs it, so we re populate full payments
    await this.populate("payments").execPopulate();

    const balanceAndCardPayments = this.payments.filter(
      (p: DocumentType<Payment>) =>
        [
          PaymentGateway.Balance,
          PaymentGateway.Card,
          PaymentGateway.Contract
        ].includes(p.gateway) &&
        p.amount >= 0 &&
        p.paid &&
        !p.original &&
        !p.refunded
    );

    const pointsPayments = this.payments.filter(
      (p: DocumentType<Payment>) =>
        [PaymentGateway.Points].includes(p.gateway) &&
        p.amountInPoints &&
        p.amountInPoints > 0 &&
        p.paid &&
        !p.original &&
        !p.refunded
    );

    const extraPayments = this.payments.filter(
      (p: DocumentType<Payment>) =>
        ![
          PaymentGateway.Balance,
          PaymentGateway.Card,
          PaymentGateway.Contract
        ].includes(p.gateway) &&
        p.amount >= 0 &&
        p.paid &&
        !p.original &&
        !p.refunded
    );

    for (const payment of balanceAndCardPayments) {
      const p = payment;
      const refundPayment = new PaymentModel({
        scene: p.scene,
        customer: p.customer,
        store: this.store,
        amount: -p.amount,
        amountDeposit: p.amountDeposit ? -p.amountDeposit : undefined,
        amountForceDeposit: p.amountForceDeposit
          ? -p.amountForceDeposit
          : undefined,
        title: `退款：${p.title}`,
        booking: p.booking,
        gateway: p.gateway,
        card: p.card,
        times: p.times ? -p.times : undefined,
        gatewayData: p.gatewayData,
        original: p.id
      });
      p.refunded = true;
      await refundPayment.save();
      await p.save();
      this.payments.push(refundPayment);
    }

    for (const payment of pointsPayments) {
      const p = payment;
      const refundPayment = new PaymentModel({
        scene: p.scene,
        customer: p.customer,
        store: this.store,
        amount: 0,
        amountInPoints: p.amountInPoints && -p.amountInPoints,
        title: `积分退还：${p.title}`,
        booking: p.booking,
        gateway: p.gateway,
        gatewayData: p.gatewayData,
        original: p.id
      });
      p.refunded = true;
      await refundPayment.save();
      await p.save();
      this.payments.push(refundPayment);
    }

    await Promise.all(
      extraPayments.map(async (p: DocumentType<Payment>) => {
        const refundPayment = new PaymentModel({
          scene: p.scene,
          customer: p.customer,
          store: this.store,
          amount: -p.amount,
          title: `退款：${p.title}`,
          booking: p.booking,
          gateway: p.gateway,
          original: p.id
        });
        p.refunded = true;
        // refund payment should go before original save
        // in case refund payment save throws error
        await refundPayment.save();
        await p.save();
        this.payments.push(refundPayment);
      })
    );
  }

  async refundSuccess(this: DocumentType<Booking>) {
    this.status = BookingStatus.CANCELED;

    if (this.type === Scene.EVENT) {
      if (!this.populated("event")) {
        await this.populate({
          path: "event",
          select: "-content"
        }).execPopulate();
      }
      if (!this.event || !this.kidsCount) {
        throw new Error("invalid_event");
      }
      if (this.event.kidsCountMax && this.event.kidsCountLeft) {
        this.event.kidsCountLeft += this.kidsCount;
        await this.event.save();
      }
    } else if (this.type === Scene.GIFT) {
      if (!this.populated("gift")) {
        await this.populate("gift").execPopulate();
      }
      if (!this.gift || !this.quantity) {
        throw new Error("invalid_gift");
      }
      if (this.gift.quantity) {
        this.gift.quantity += this.quantity;
        await this.gift.save();
      }
    } else if (this.type === Scene.FOOD) {
      if (this.providerData?.provider === "pospal") {
        if (!this.store?.code)
          throw new Error("pospal_booking_missing_store_code");
        new Pospal(this.store.code).cancelOnlineOrder(this.providerData.sn);
      }
    }

    const amountRefundedNoCoupon = this.payments.reduce((amount, p) => {
      if (p.paid && p.original && p.gateway !== PaymentGateway.Coupon) {
        amount += p.amount;
      }
      return amount;
    }, 0);

    await this.customer?.addPoints(amountRefundedNoCoupon);
    // send user notification
  }

  async setAmountPaid(
    this: DocumentType<Booking>,
    forcePopulatePayments = false
  ): Promise<void> {
    if (!this.populated("payments") || forcePopulatePayments) {
      await this.populate({
        path: "payments",
        options: { sort: { _id: -1 } },
        select: "-customer"
      }).execPopulate();
    }
    const paymentsAmounts = this.payments.reduce(
      (total, payment) => {
        if (payment.paid) {
          total.amountPaid += payment.amount;
          if (
            [PaymentGateway.Card, PaymentGateway.Contract].includes(
              payment.gateway
            )
          ) {
            total.amountPaidInCard += payment.amount;
          }
          if (payment.gateway === PaymentGateway.Balance) {
            total.amountPaidInDeposit += payment.amountDeposit || 0;
            total.amountPaidInBalance += payment.amount;
          }
          if (payment.amountInPoints) {
            total.amountPaidInPoints += payment.amountInPoints;
          }
        }
        return total;
      },
      {
        amountPaid: 0,
        amountPaidInBalance: 0,
        amountPaidInDeposit: 0,
        amountPaidInCard: 0,
        amountPaidInPoints: 0
      }
    ) as Amounts;

    (
      [
        "amountPaid",
        "amountPaidInDeposit",
        "amountPaidInBalance",
        "amountPaidInCard",
        "amountPaidInPoints"
      ] as Array<keyof Amounts>
    ).forEach(amountField => {
      if (paymentsAmounts[amountField]) {
        this[amountField] = paymentsAmounts[amountField];
      } else {
        this[amountField] = undefined;
      }
    });
  }

  async checkIn(this: DocumentType<Booking>) {
    this.status = BookingStatus.IN_SERVICE;
    this.checkInAt = moment().format("HH:mm:ss");

    console.log(`[BOK] Check-in ${this.id}.`);

    if (this.card) {
      // force reload card, because checkIn may call by booking.paymentSuccess
      // and booking.card.timesLeft has not been updated.
      await this.populate("card").execPopulate();
    }

    if (this.coupon && !this.populated("coupon")) {
      await this.populate("coupon").execPopulate();
    }

    const customer = await UserModel.findById(this.customer);

    const rewardCardTypesString =
      this.coupon?.rewardCardTypes ||
      (this.card?.type !== "balance" && this.card?.rewardCardTypes);

    if (rewardCardTypesString && this.kidsCount && customer) {
      const rewardCardTypes = await CardTypeModel.find({
        slug: { $in: rewardCardTypesString.split(" ") }
      });

      let n = 1;

      if (this.coupon) {
        n = this.kidsCount / this.coupon.kidsCount;
      }

      if (this.card && this.card.cardsRewarded) {
        n = 0;
      }

      for (let i = 0; i < n; i++) {
        for (const cardType of rewardCardTypes) {
          const card = cardType.issue(customer);

          card.paymentSuccess();
          card.rewardedFromBooking = this;

          await card.save();
          console.log(
            `[BOK] ${this.id} rewarded card ${card.id} ${card.slug} to customer ${customer.id}.`
          );
        }
      }

      if (this.card && !this.card.cardsRewarded) {
        this.card.cardsRewarded = true;
        await this.card.save(); // TODO conflict with -timesLeft
      }
    }

    if (
      this.type === Scene.PLAY &&
      customer &&
      this.store &&
      !customer.firstPlayStore &&
      !customer.firstPlayDate
    ) {
      customer.firstPlayDate = this.date;
      customer.firstPlayStore = this.store?.id;
      await customer.save();
    }

    if (this.card?.type === "times" && customer && this.store) {
      sendTemplateMessage(customer, TemplateMessageType.WRITEOFF, [
        "您的次卡已成功核销",
        customer.name || "",
        `${this.store.name} ${this.adultsCount}大${this.kidsCount}小`,
        `${this.kidsCount}`,
        `${this.date} ${this.checkInAt}`,
        `卡内剩余次数：${this.card.timesLeft}`
      ]);
    }
  }

  async cancel(this: DocumentType<Booking>, save = true) {
    if (this.status === BookingStatus.CANCELED) {
      return;
    }

    if (this.payments.filter(p => p.paid).length) {
      console.log(`[BOK] Refund ${this.id}.`);
      // we don't directly change status to canceled, will auto change on refund fullfil
      this.status = BookingStatus.PENDING_REFUND;
      await this.createRefundPayment();
      if (!this.payments.filter(p => p.amount < 0).some(p => !p.paid)) {
        this.refundSuccess();
      }
    } else {
      this.refundSuccess();
    }

    console.log(`[BOK] Cancel ${this.id}.`);

    if (save) {
      await this.save();
    }

    if (
      this.type === Scene.PLAY &&
      this.store &&
      this.customer &&
      !this.payments.some(p => p.gateway === PaymentGateway.Coupon)
    ) {
      sendTemplateMessage(this.customer, TemplateMessageType.CANCEL, [
        "您的预约已被取消",
        `${this.store.name} ${this.adultsCount}大${this.kidsCount}小`,
        `${this.date}`,
        "管理员审批",
        "您的微信支付、次卡、余额将自动原路退回；如有疑问，请联系门店"
      ]);
    }
  }

  async finish(this: DocumentType<Booking>, save = true) {
    const booking = this;

    booking.status = BookingStatus.FINISHED;

    console.log(`[BOK] Finish ${booking._id}.`);

    if (save) {
      await booking.save();
    }
  }

  async checkStoreLimit(
    this: DocumentType<Booking>,
    group: "common" | "coupon" = "common"
  ) {
    if (!this.store || !this.store.dailyLimit || !this.kidsCount) return;
    const dayOfWeek = moment(this.date).day();
    const special = this.store.dailyLimit.dates.find(
      d => d.date === this.date && d.group === group
    )?.limit;
    const common = this.store.dailyLimit[group][dayOfWeek];
    let limit: number | null = null;
    if (special !== undefined) {
      limit = special;
    } else if (common !== undefined) {
      limit = common;
    }
    if (limit !== null) {
      const bookings = await BookingModel.find({
        type: Scene.PLAY,
        store: this.store,
        date: this.date,
        status: { $in: paidBookingStatus },
        coupon: { $exists: true }
      });
      const kidsCount = bookings.reduce(
        (count, booking) => count + (booking.kidsCount || 0),
        0
      );
      if (kidsCount + this.kidsCount > limit) {
        throw new Error("store_limit_exceeded");
      }
    }
  }
}

const BookingModel = getModelForClass(Booking, {
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

export default BookingModel;
