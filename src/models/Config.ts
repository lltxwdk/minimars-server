import {
  prop,
  getModelForClass,
  plugin,
  modelOptions,
  Severity
} from "@typegoose/typegoose";
import updateTimes from "./plugins/updateTimes";

@plugin(updateTimes)
@modelOptions({ options: { allowMixed: Severity.ALLOW } })
class ConfigDocument {
  @prop()
  desc: string;

  @prop()
  value: any;

  public static async get(key: string, defaults: any) {
    const doc = await configModel.findOne({ key });
    return doc ? doc.value : defaults;
  }
}

const configModel = getModelForClass(ConfigDocument, {
  schemaOptions: {
    collection: "configs",
    strict: false,
    toJSON: {
      getters: true,
      transform: function (doc, ret, options) {
        delete ret._id;
        delete ret.__v;
      }
    }
  }
});

export default configModel;

export class Config {
  sockPrice?: number;
  extraParentFullDayPrice?: number;
  kidFullDayPrice?: number;
  freeParentsPerKid?: number;
  appointmentDeadline?: string;
  eventHint?: string;
  playHint?: string;
  offWeekdays?: string[];
  onWeekends?: string[];
}

export const config: Config = {};
