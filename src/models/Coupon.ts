import {
  prop,
  getModelForClass,
  plugin,
  Ref,
  modelOptions,
  Severity,
  pre,
  DocumentType
} from "@typegoose/typegoose";
import HttpError from "../utils/HttpError";
import CardTypeModel from "./CardType";
import { Store } from "./Store";
import updateTimes from "./plugins/updateTimes";
import { Scene } from "./Payment";
import moment from "moment";

@plugin(updateTimes)
@modelOptions({ options: { allowMixed: Severity.ALLOW } })
@pre("validate", async function (this: DocumentType<Coupon>, next) {
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
export class Coupon {
  @prop({ required: true })
  title!: string;

  @prop()
  slug?: string;

  @prop({ default: Scene.PLAY })
  scene = Scene.PLAY;

  @prop({ ref: "Store" })
  stores!: Ref<Store>[];

  @prop()
  content?: string;

  @prop({ type: Number, default: 1 })
  kidsCount = 1;

  @prop({ type: Number })
  price?: number;

  @prop({ type: Number, required: true })
  priceThirdParty!: number;

  @prop({ type: Number })
  priceThirdPartyInternal?: number;

  @prop({ type: Number, default: 2 })
  freeParentsPerKid: number = 2;

  @prop()
  start?: Date;

  @prop()
  end?: Date;

  @prop()
  enabled = true;

  @prop()
  rewardCardTypes?: string;

  @prop({ type: Number })
  overPrice?: number;

  @prop({ type: Number })
  discountPrice?: number;

  @prop({ type: Number })
  discountRate?: number;

  @prop({ type: Number })
  fixedPrice?: number;
}

const CouponModel = getModelForClass(Coupon, {
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

export default CouponModel;
