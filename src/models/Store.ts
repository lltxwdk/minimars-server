import mongoose, { Schema } from "mongoose";
import updateTimes from "./plugins/updateTimes";
import { Socket } from "net";

const Store = new Schema({
  name: String,
  address: String,
  phone: String,
  partyRooms: Number,
  ip: String
});

Store.index({ name: 1 }, { unique: true });

Store.plugin(updateTimes);

Store.set("toJSON", {
  getters: true,
  transform: function(doc, ret, options) {
    delete ret._id;
    delete ret.__v;
  }
});

export interface IStore extends mongoose.Document {
  name: string;
  address: string;
  phone: string;
  partyRooms: number;
  ip: string;
}

export default mongoose.model<IStore>("Store", Store);
