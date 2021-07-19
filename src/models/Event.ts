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
  appendResizeImageUrl,
  removeResizeImageUrl,
  removeResizeHtmlImage
} from "../utils/imageResize";
import moment from "moment";

@pre("validate", function (next) {
  const event = this as DocumentType<Event>;
  if (
    event.kidsCountMax !== null &&
    (event.kidsCountLeft === null || event.kidsCountLeft === undefined)
  ) {
    event.kidsCountLeft = event.kidsCountMax;
  }
  if (event.kidsCountLeft !== null && event.kidsCountMax === null) {
    event.kidsCountLeft = null;
  }
  if (event.tags) {
    event.tags = event.tags.map(t => t.toLowerCase());
  }
  next();
})
@plugin(updateTimes)
@plugin(autoPopulate, [{ path: "store", select: "-content" }])
@modelOptions({ options: { allowMixed: Severity.ALLOW } })
export class Event {
  @prop({ required: true })
  title!: string;

  @prop({ type: String })
  tags!: string[];

  @prop({
    required: true,
    get: v => appendResizeImageUrl(v),
    set: v => removeResizeImageUrl(v)
  })
  posterUrl!: string;

  @prop({
    get: v => appendResizeImageUrl(v),
    set: v => removeResizeImageUrl(v)
  })
  posterDenseUrl?: string;

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
