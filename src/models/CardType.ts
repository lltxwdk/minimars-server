import {
  prop,
  getModelForClass,
  plugin,
  DocumentType,
  pre
} from "@typegoose/typegoose";
import updateTimes from "./plugins/updateTimes";
import { Store } from "./Store";
import { User } from "./User";
import CardModel, { BalanceGroup } from "./Card";
import autoPopulate from "./plugins/autoPopulate";
import HttpError from "../utils/HttpError";
import moment from "moment";
import { Scene } from "./Payment";
import {
  appendResizeImageUrl,
  removeResizeImageUrl
} from "../utils/imageResize";

class BalancePriceGroup {
  @prop({ type: Number, required: true })
  balance!: number;

  @prop({ type: Number, required: true })
  price!: number;
}

@plugin(updateTimes)
@plugin(autoPopulate, [{ path: "stores", select: "name code" }])
@pre("validate", async function (this: DocumentType<CardType>, next) {
  if (this.customerTags) {
    this.customerTags = this.customerTags.map(t => t.toLowerCase());
  }
  if (this.expiresInDays === undefined && !this.end === undefined) {
    throw new HttpError(400, "有效时长和有效期必选一项");
  }
  if (this.type === "balance") {
    if (this.balance === undefined || this.price === undefined)
      throw new HttpError(400, "面值，价格必填");
    if (this.balancePriceGroups) {
      this.balancePriceGroups = this.balancePriceGroups.filter(
        g => g.price !== undefined && g.balance !== undefined
      );
    }
  }
  if (this.type === "times" && isNaN(this.times || NaN)) {
    throw new HttpError(400, "次卡类型必须设置次数");
  }
  if (this.type === "coupon") {
    if (isNaN(this.times || NaN)) this.times = 1;
    if (
      isNaN(this.discountPrice || NaN) &&
      isNaN(this.discountRate || NaN) &&
      this.fixedPrice === undefined
    ) {
      throw new HttpError(400, "优惠券减、折、价格必须至少选择一种");
    }
  }
  if (this.rewardCardTypes) {
    for (const slug of this.rewardCardTypes.split(/[ ；;,，、\/]+/)) {
      const card = await CardTypeModel.findOne({ slug });
      if (!card) {
        throw new HttpError(400, `不存在这个卡券种类：${slug}`);
      }
      if (card.rewardCardTypes) {
        throw new HttpError(400, `赠送的卡券种类不能再赠卡：${slug}`);
      }
    }
  }
  if (this.start) {
    this.start = moment(this.start).startOf("day").toDate();
  }
  if (this.end) {
    this.end = moment(this.end).endOf("day").toDate();
  }
  if (this.fixedPrice === null) {
    this.fixedPrice = undefined;
  }
  if (this.overPrice === null) {
    this.overPrice = undefined;
  }
  next();
})
export class CardType {
  @prop({ required: true })
  title!: string;

  @prop({ required: true, unique: true })
  slug!: string;

  @prop({
    enum: ["times", "period", "balance", "coupon", "partner"],
    required: true
  })
  type!: "times" | "period" | "balance" | "coupon" | "partner";

  @prop({ type: Number, required: true })
  price!: number;

  @prop({ ref: "Store" })
  stores!: DocumentType<Store>[];

  @prop({ type: Number })
  expiresInDays?: number;

  @prop({ type: Date })
  start?: Date;

  @prop({ type: Date })
  end?: Date;

  @prop()
  dayType?: "onDaysOnly" | "offDaysOnly";

  @prop({ type: Boolean })
  isGift?: boolean;

  @prop({ type: Boolean, default: true })
  isContract: boolean = true;

  @prop({ type: Boolean, default: false })
  isLimited: boolean = false;

  @prop({ type: Boolean, default: false })
  isCombo: boolean = false;

  @prop({ type: Boolean, default: false })
  openForClient: boolean = false;

  @prop({ type: Boolean, default: false })
  openForReception: boolean = false;

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

  @prop({ type: String, default: [] })
  posterUrls: string[] = [];

  @prop()
  content?: string;

  @prop()
  couponSlug?: string;

  @prop({ type: String })
  customerTags!: string[];

  @prop({ type: Number })
  maxPerCustomer?: number;

  @prop({ type: Number })
  quantity?: number;

  @prop()
  rewardCardTypes?: string;

  @prop({ type: Boolean })
  rewardCardEveryTime?: boolean;

  // type-related properties below
  @prop({ type: Number })
  times?: number;

  @prop({ type: Number })
  balance?: number;

  @prop({ type: BalancePriceGroup })
  balancePriceGroups?: BalancePriceGroup[];

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

  issue(
    this: DocumentType<CardType>,
    customer: DocumentType<User>,
    {
      quantity = undefined,
      balanceGroups = undefined
    }: {
      quantity?: number;
      balanceGroups?: BalanceGroup[];
    } = {}
  ) {
    const card = new CardModel({
      customer: customer.id
    });

    if (this.stores) {
      card.stores = this.stores.map(s => s.id);
    }

    (Object.keys(this.toObject()) as Array<keyof CardType>)
      .filter(
        key =>
          ![
            "_id",
            "__v",
            "createdAt",
            "updatedAt",
            "store",
            "quantity"
          ].includes(key)
      )
      .forEach(key => {
        card.set(key, this[key]);
      });

    if (this.times) {
      if (quantity) {
        card.quantity = quantity;
        card.times = this.times * quantity;
        card.price = this.price * quantity;
      }
      card.timesLeft = card.times;
    }

    balanceGroups = balanceGroups?.filter(
      g => g.count >= 1 && g.count % 1 === 0
    );

    if (balanceGroups && balanceGroups.length) {
      card.price = balanceGroups.reduce((price, group) => {
        const balancePriceGroup = this.balancePriceGroups?.find(
          pg => pg.balance === group.balance
        );
        if (!balancePriceGroup) {
          throw new HttpError(400, `不支持这个金额：${group.balance}`);
        }
        return +(price + (balancePriceGroup.price || 0) * group.count).toFixed(
          10
        );
      }, 0);
      card.balance = balanceGroups.reduce(
        (price, group) => +(price + group.balance * group.count).toFixed(10),
        0
      );
    }

    if (this.end) {
      card.expiresAt = moment(this.end).endOf("day").toDate();
    } else if (this.expiresInDays !== undefined) {
      card.expiresAt = moment(card.start || undefined)
        .add(this.expiresInDays, "days")
        .endOf("day")
        .toDate();
    }

    if (this.type === Scene.PERIOD) {
      if (!this.start) {
        card.start = moment().startOf("day").toDate();
      }
      if (!this.end) {
        card.end = moment(card.expiresAt).endOf("day").toDate();
      }
    }

    return card;
  }
}

export const typeRelatedProperties: Array<keyof CardType> = [
  "times",
  "balance",
  "balancePriceGroups",
  "maxKids",
  "minKids",
  "freeParentsPerKid",
  "overPrice",
  "discountPrice",
  "discountRate",
  "fixedPrice",
  "partnerUrl"
];

const CardTypeModel = getModelForClass(CardType, {
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

export default CardTypeModel;
