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
import cardTypeModel from "./CardType";
import updateTimes from "./plugins/updateTimes";
import { Store } from "./Store";

@plugin(updateTimes)
@modelOptions({ options: { allowMixed: Severity.ALLOW } })
@pre("validate", async function (this: DocumentType<Coupon>, next) {
  if (this.rewardCardTypes) {
    for (const slug of this.rewardCardTypes.split(" ")) {
      const card = await cardTypeModel.findOne({ slug });
      if (!card) {
        throw new HttpError(400, `不存在这个卡券种类：${slug}`);
      }
      if (card.rewardCardTypes) {
        throw new HttpError(400, `赠送的卡券种类不能再赠卡：${slug}`);
      }
    }
  }
  next();
})
export class Coupon {
  @prop({ required: true })
  title: string;

  @prop({ ref: "Store" })
  stores: Ref<Store>[];

  @prop()
  content: string;

  @prop({ type: Number })
  kidsCount = 1;

  @prop({ type: Number })
  price = 0;

  @prop({ type: Number })
  priceThirdParty: number;

  @prop({ type: Number, default: 2 })
  freeParentsPerKid: number;

  @prop()
  start?: Date;

  @prop()
  end?: Date;

  @prop()
  enabled = true;

  @prop()
  rewardCardTypes?: string;
}

const cardModel = getModelForClass(Coupon, {
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

export default cardModel;
