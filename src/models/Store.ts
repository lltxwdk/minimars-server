import moment from "moment";
import { Socket } from "net";
import { JxCtl } from "jingxing-doors";
import {
  prop,
  getModelForClass,
  plugin,
  DocumentType,
  modelOptions,
  Severity
} from "@typegoose/typegoose";
import updateTimes from "./plugins/updateTimes";
import {
  appendResizeImageUrl,
  appendResizeHtmlImage,
  removeResizeImageUrl,
  removeResizeHtmlImage
} from "../utils/imageResize";
import { sleep } from "../utils/helper";
import BookingModel, { BookingStatus } from "./Booking";
import Pospal, { Ticket, Menu } from "../utils/pospal";
import PaymentModel, { PaymentGateway, Scene } from "./Payment";
import UserModel from "./User";
import WebSocket from "ws";

export const storeMap: { [id: string]: DocumentType<Store> } = {};
export const storeDoors: { [storeId: string]: Door[] } = {};
export const storeServerSockets: { [storeId: string]: Socket } = {};

class DailyLimitDate {
  @prop({ required: true })
  date!: string;
  @prop({ required: true })
  group!: string;
  @prop({ type: Number, required: true })
  limit!: number;
}

class DailyLimit {
  @prop({ type: Number, required: true })
  common!: number[];
  @prop({ type: Number, required: true })
  coupon!: number[];
  @prop({ type: DailyLimitDate, required: true })
  dates!: DailyLimitDate[];
}

class Door {
  @prop({ required: true })
  ip!: string;
  @prop({ required: true })
  name!: string;
  @prop()
  io!: "in" | "out";
  controller?: JxCtl;
}

export class FaceDevice {
  ws?: WebSocket;

  @prop({ required: true })
  mac!: string;

  @prop()
  storeCode?: string;

  @prop({ required: true })
  name!: string;

  @prop({ required: true })
  io!: "in" | "out";
}

@plugin(updateTimes)
@modelOptions({ options: { allowMixed: Severity.ALLOW } })
export class Store {
  @prop({ unique: true })
  name!: string;

  @prop({ unique: true })
  code!: string;

  @prop()
  address!: string;

  @prop()
  phone!: string;

  @prop({ type: Number })
  order = 0;

  @prop({
    required: true,
    get: v => appendResizeImageUrl(v),
    set: v => removeResizeImageUrl(v)
  })
  posterUrl!: string;

  @prop({
    get: v => appendResizeHtmlImage(v),
    set: v => removeResizeHtmlImage(v)
  })
  content?: string;

  @prop({
    default: { common: [], coupon: [], dates: [] }
  })
  dailyLimit: DailyLimit = { common: [], coupon: [], dates: [] };

  @prop()
  partyRooms?: number;

  @prop({ type: Door })
  doors?: Door[];

  @prop({ type: FaceDevice })
  faceDevices?: FaceDevice[];

  @prop()
  ip?: string;

  @prop({ type: Number })
  kidFullDayPrice?: number;

  @prop({ type: Number })
  freeParentsPerKid?: number;

  @prop({ type: Number })
  extraParentFullDayPrice?: number;

  @prop({ type: Object })
  pospalPaymentMethodMap?: Record<string, PaymentGateway>;

  @prop({ type: Object, select: false })
  foodMenu?: Menu;

  async authDoors(this: DocumentType<Store>, no: number) {
    if (no >= Math.pow(2, 32) || no <= 0) {
      console.error(`[STR] Auth number out of range: "${no}"`);
      return;
    }
    const doors = storeDoors[this.id];
    if (!doors) {
      console.error(
        `[STR] Doors has not been registered in store ${this.code}.`
      );
      return;
    }
    for (const door of doors) {
      await sleep(1000);
      console.log(`[STR] ${this.code}: auth ${no} to store ${this.code}.`);
      door.controller?.registerCard(no, moment().format("YYYY-MM-DD"));
    }
  }

  openDoor(this: DocumentType<Store>, name: string) {
    const doors = storeDoors[this.id];
    if (!doors) {
      console.error(
        `[STR] Doors has not been registered in store ${this.code}.`
      );
      return;
    }
    const door = doors.find(d => d.name === name);
    if (!door) {
      console.error(`[STR] Door ${name} not found in store ${this.code}.`);
      return;
    }
    door.controller?.openDoor(0); // assume 1-1 controller-door, so each controller has only 1 door
  }

  async initDoors(this: DocumentType<Store>) {
    const doors = storeDoors[this.id];
    if (!doors) {
      console.error(
        `[STR] Doors has not been registered in store ${this.code}.`
      );
      return;
    }
    for (const door of doors) {
      await sleep(1000);
      door.controller?.init();
    }
  }

  async syncPospalTickets(from: string | number, to?: string) {
    if (process.env.DISABLE_POSPAL_SYNC) {
      console.log(
        "Mock sync pospal tickets:",
        this.code,
        moment().format("HH:mm:ss")
      );
      return;
    }

    const pospal = new Pospal(this.code);
    const result: Ticket[] =
      typeof from === "number"
        ? await pospal.queryTickets(from)
        : await pospal.queryMultiDateTickets(from, to);

    let invalidPaymentMethodCodes: string[] = [];
    result.forEach(t => {
      t.payments.forEach(p => {
        if (
          !this.pospalPaymentMethodMap?.[p.code] &&
          !invalidPaymentMethodCodes.includes(p.code)
        ) {
          invalidPaymentMethodCodes.push(p.code);
        }
      });
    });
    if (invalidPaymentMethodCodes.length) {
      pospal.queryAllPayMethod().then((methods: { code: string }[]) => {
        const methodsUndefined = methods.filter(m =>
          invalidPaymentMethodCodes.includes(m.code)
        );
        for (const method of methodsUndefined) {
          console.error(
            `[STR] Need method ${JSON.stringify(method)} to be configured at ${
              this.code
            }.`
          );
        }
      });
      throw new Error("invalid_payment_code");
    }
    if (typeof from !== "number") {
      console.log(
        `[STR] ${this.code}: fetched ${result.length} Pospal tickets.`
      );
    }
    let insertBookings = 0;
    for (const ticket of result) {
      if (ticket.invalid) {
        continue;
      }
      try {
        const [date, checkInAt] = ticket.datetime.split(" ");
        const items = ticket.items;
        delete ticket.items;
        const booking = new BookingModel({
          type: Scene.FOOD,
          status: BookingStatus.FINISHED,
          date,
          checkInAt,
          price: ticket.totalAmount,
          store: this, // TODO conditional store
          // TODO booking card
          // TODO booking customer
          items,
          providerData: { provider: "pospal", ...ticket, payments: undefined },
          createdAt: new Date(ticket.datetime)
        });

        if (ticket.customerUid) {
          const customer = await UserModel.findOne({
            pospalId: ticket.customerUid.toString()
          });
          if (customer) {
            booking.customer = customer;
          } else {
            // find customer in pospal by customerUid, get mobile,
            const member = await pospal.getMember(
              ticket.customerUid.toString()
            );
            // find user by mobile, save pospalId
            const customer = await UserModel.findOne({ mobile: member.phone });
            if (customer) {
              customer.pospalId = ticket.customerUid.toString();
              await customer.save();
              booking.customer = customer;
            } else {
              console.error(
                `[STR] Failed to find customer when sync booking from Pospal, booking ${booking.id} customerUid ${ticket.customerUid}.`
              );
            }
          }
        }

        const payments = ticket.payments
          .map(p => {
            const payment = new PaymentModel({
              scene: Scene.FOOD,
              title: "餐饮消费",
              customer: booking.customer,
              store: this,
              amount: p.amount,
              booking: booking.id,
              gateway: this.pospalPaymentMethodMap?.[p.code],
              gatewayData: { provider: "pospal" },
              createdAt: new Date(ticket.datetime)
            });
            return payment;
          })
          // drop internal payment
          .filter(p => p.gateway !== PaymentGateway.Internal);

        if (!payments.length) continue;

        await booking.save(); // may throw duplicate error so skip payment saving below
        insertBookings++;
        await Promise.all(payments.map(async p => p.save()));
        await booking.populate("payments").execPopulate();
        await booking.paymentSuccess();
        await booking.save();
      } catch (e) {
        if (e.code === 11000) {
        } else if (e.message === "insufficient_balance") {
        } else {
          console.error(e);
        }
        continue;
      }
    }
    if (typeof from !== "number" || insertBookings) {
      console.log(
        `[STR] ${this.code}: created ${insertBookings} food bookings.`
      );
    }
  }

  async checkPospalPaymentMethods() {
    const allMethods = await new Pospal(this.code).queryAllPayMethod();
    const currentMethodMap = this?.pospalPaymentMethodMap;
    if (currentMethodMap) {
      for (let m in currentMethodMap) {
        const methodItem = allMethods.find((item: any) => item.code === m);
        if (!methodItem) {
          console.log(`[STR] ${this.code}`, m, "not found.");
          continue;
        }
        console.log(
          `[STR] ${this.code} ${m} -> ${currentMethodMap[m]}, pospal: ${methodItem.showName}`
        );
      }
    }
  }
}

const StoreModel = getModelForClass(Store, {
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

export async function loadStoreMap() {
  const stores = await StoreModel.find().select("+foodMenu");
  stores.forEach(s => {
    storeMap[s.id] = s;
  });
  console.log(`[STR] Store map loaded.`);
}

export default StoreModel;
