import {
  prop,
  getModelForClass,
  plugin,
  pre,
  DocumentType,
  modelOptions,
  Severity
} from "@typegoose/typegoose";
import { Schema } from "mongoose";
import updateTimes from "./plugins/updateTimes";
import { Store } from "./Store";
import autoPopulate from "./plugins/autoPopulate";
import {
  appendResizeHtmlImage,
  removeResizeHtmlImage
} from "../utils/imageResize";
import moment from "moment";
import HttpError from "../utils/HttpError";

@pre("validate", function (this: DocumentType<Event>) {
  if (
    this.kidsCountMax !== null &&
    (this.kidsCountLeft === null || this.kidsCountLeft === undefined)
  ) {
    this.kidsCountLeft = this.kidsCountMax;
  }
  if (this.kidsCountLeft !== null && this.kidsCountMax === null) {
    this.kidsCountLeft = null;
  }
  if (this.tags) {
    this.tags = this.tags.map(t => t.toLowerCase());
  }
  if (this.priceInPoints === null) {
    this.priceInPoints = undefined;
  }
  if (this.price === null) {
    this.price = undefined;
  }
  if (this.priceInPoints === undefined && this.price === undefined) {
    throw new HttpError(400, "积分和收款售价至少填写一项");
  }
})
@plugin(updateTimes)
@plugin(autoPopulate, [{ path: "store", select: "-content" }])
@modelOptions({ options: { allowMixed: Severity.ALLOW } })
export class Event {
  @prop({ required: true })
  title!: string;

  @prop({ type: String })
  tags!: string[];

  @prop({ required: true })
  ipCharacter!: string;

  @prop({
    get: v => appendResizeHtmlImage(v),
    set: v => removeResizeHtmlImage(v)
  })
  content?: string;

  @prop({
    type: Schema.Types.Mixed,
    default: null,
    get: v => v,
    set(v) {
      if (!v) {
        return null;
      } else return +v;
    }
  })
  kidsCountMax!: number | null;

  @prop({
    type: Schema.Types.Mixed,
    default: null
  })
  kidsCountLeft!: number | null;

  @prop({ type: Object })
  props?: Object;

  @prop()
  priceInPoints?: number;

  @prop()
  price?: number;

  @prop({
    type: Date,
    get: v => v,
    set: v => {
      if (moment(v, moment.ISO_8601).isValid()) {
        return moment(v).endOf("day").toDate();
      }
      return v;
    }
  })
  date?: Date;

  @prop({ ref: "Store" })
  store?: DocumentType<Store>;

  @prop({ type: Number, default: 0 })
  order: number = 0;

  @prop({ type: String })
  kidAgeRange?: string;
}

const EventModel = getModelForClass(Event, {
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

export default EventModel;
