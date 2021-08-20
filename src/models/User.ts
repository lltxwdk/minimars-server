import {
  prop,
  getModelForClass,
  plugin,
  pre,
  DocumentType,
  index,
  Ref
} from "@typegoose/typegoose";
import moment from "moment";
import updateTimes from "./plugins/updateTimes";
import { Store } from "./Store";
import autoPopulate from "./plugins/autoPopulate";
import Pospal from "../utils/pospal";
import { syncUserPoints } from "../utils/youzan";
import { Role, Permission } from "./Role";
import { Gift } from "./Gift";

@pre("validate", function (this: DocumentType<User>, next) {
  if (this.balanceDeposit)
    this.balanceDeposit = +this.balanceDeposit.toFixed(2);
  if (this.balanceReward) this.balanceReward = +this.balanceReward.toFixed(2);
  if (!this.role && this.points === undefined) {
    this.points = 0;
  }
  if (this.tags) {
    this.tags = this.tags.map(t => t.toLowerCase());
  }
  if (this.mobile) {
    this.mobileSegments = [this.mobile.substr(-4), this.mobile.substr(-5)].join(
      " "
    );
  }
  next();
})
@plugin(updateTimes)
@plugin(autoPopulate, [
  { path: "store", select: "-content" },
  { path: "role" },
  { path: "covers", select: "title posterUrl" },
  ,
  { path: "currentCover", select: "title posterUrl" }
])
@index({
  name: "text",
  mobile: "text",
  cardNo: "text",
  tags: "text",
  mobileSegments: "text"
})
export class User {
  @prop({ ref: Role })
  role?: DocumentType<Role>;

  @prop({ unique: true, sparse: true })
  login?: string;

  @prop({ select: false })
  password?: string;

  @prop()
  name?: string;

  @prop()
  childName?: string;

  @prop()
  childBirthday?: string;

  @prop()
  childPhotoUrl?: string;

  @prop({
    type: String,
    get: v => v,
    set: v => {
      const genderIndex = ["未知", "男", "女"];
      return genderIndex[v] || v;
    }
  })
  gender?: string;

  @prop({
    unique: true,
    sparse: true,
    // @ts-ignore
    validate: {
      validator: function (v) {
        return (
          v.length === 11 || v.match(/^\+/) || process.env.SUPPRESS_VALIDATOR
        );
      },
      message: (props: { value: any }) =>
        `手机号必须是11位数或“+”开头的国际号码，输入的是${JSON.stringify(
          props.value
        )}`
    }
  })
  mobile?: string;

  @prop()
  mobileSegments?: string;

  @prop()
  avatarUrl?: string;

  @prop()
  region?: string;

  @prop()
  country?: string;

  @prop()
  isForeigner?: boolean;

  @prop()
  birthday?: string;

  @prop()
  constellation?: string;

  @prop({ index: true })
  idCardNo?: string;

  @prop()
  openid?: string;

  @prop()
  openidMp?: string;

  @prop()
  unionid?: string;

  @prop()
  openidByte?: string;

  @prop()
  unionidByte?: string;

  @prop()
  pospalId?: string;

  @prop()
  youzanId?: string;

  @prop({ ref: "Store" }) // manager only
  store?: DocumentType<Store>;

  @prop({ type: Number }) // below for customer only
  balanceDeposit?: number;

  @prop({ type: Number })
  balanceReward?: number;

  get balance() {
    return +((this.balanceDeposit || 0) + (this.balanceReward || 0)).toFixed(2);
  }

  @prop({ type: String, default: [] })
  tags: string[] = [];

  @prop()
  points?: number;

  @prop()
  cardType?: string;

  @prop({ index: true })
  cardNo?: string;

  @prop()
  firstPlayDate?: string;

  @prop({ ref: "Store" })
  firstPlayStore?: Ref<Store>;

  @prop()
  registeredAt?: string;

  @prop({
    remarks: String,
    set: (v: string) => {
      if (!v) return v;
      const lines = v.split("\n");
      return lines
        .map(line => {
          if (line && !line.match(/^\d{4}-\d{2}-\d{2}: /)) {
            line = moment().format("YYYY-MM-DD") + ": " + line;
          }
          return line;
        })
        .join("\n");
    },
    get: v => v
  })
  remarks?: string;

  @prop({ ref: Gift, default: [] })
  covers: DocumentType<Gift>[] = [];

  @prop({ ref: Gift })
  currentCover?: DocumentType<Gift>;

  can(...ps: Permission[]) {
    return ps.every(p => this.role?.can(p));
  }

  async addPoints(this: DocumentType<User>, amount: number) {
    amount = +amount.toFixed();
    if (!amount) return;
    if (!this.points) this.points = 0;
    this.points += amount;
    await this.updateOne({ $inc: { points: amount } }).exec();
    console.log(
      `[USR] Add points for ${this.mobile} ${this.id} by ${amount}, to ${this.points}.`
    );
    syncUserPoints(this).catch(err => {});
  }

  async depositBalance(
    this: DocumentType<User>,
    balance: number,
    amountDeposit: number,
    save = true
  ) {
    const balanceDepositWas = this.balanceDeposit,
      balanceRewardWas = this.balanceReward;

    if (this.balanceDeposit === undefined) this.balanceDeposit = 0;
    if (this.balanceReward === undefined) this.balanceReward = 0;

    this.balanceDeposit = +(this.balanceDeposit + amountDeposit).toFixed(2);
    this.balanceReward = +(
      this.balanceReward +
      balance -
      amountDeposit
    ).toFixed(2);

    if (save) {
      await this.save();
    }

    new Pospal().addMember(this);

    console.log(
      `[USR] Deposit balance of ${this.id} to ${this.balanceDeposit}:${this.balanceReward}, was ${balanceDepositWas}:${balanceRewardWas}.`
    );
  }

  async writeOffBalance(
    this: DocumentType<User>,
    amount: number,
    amountForceDeposit = 0,
    amountDeposit?: number,
    save = true,
    syncToPospal = true
  ) {
    if (this.balance < amount) {
      console.log(
        `[USR] Insufficient balance ${this.balance} of user ${this.id}, trying to write-off ${amount}.`
      );
      throw new Error("insufficient_balance");
    }

    let balanceDeposit = this.balanceDeposit || 0;
    let balanceReward = this.balanceReward || 0;

    const balanceDepositWas = balanceDeposit,
      balanceRewardWas = balanceReward;

    const depositPaymentAmount =
      amountDeposit ||
      Math.max(
        +(
          amountForceDeposit +
          ((amount - amountForceDeposit) * balanceDeposit) / this.balance
        ).toFixed(2),
        0.01
      );

    const rewardPaymentAmount = +(amount - depositPaymentAmount).toFixed(2);
    balanceDeposit -= depositPaymentAmount;
    balanceReward -= rewardPaymentAmount;

    if (balanceDeposit !== balanceDepositWas) {
      this.balanceDeposit = balanceDeposit;
    }

    if (balanceReward !== balanceRewardWas) {
      this.balanceReward = balanceReward;
    }

    if (syncToPospal) {
      new Pospal().addMember(this).catch(e => {
        console.error(
          `[USR] Sync ${this.id} ${this.mobile} to pospal failed: ${e.message}.`
        );
      });
    }

    if (save) {
      await this.save();
    }

    console.log(
      `[USR] Write off balance of ${this.id} to ${this.balanceDeposit}:${this.balanceReward}, was ${balanceDepositWas}:${balanceRewardWas}.`
    );

    return {
      depositPaymentAmount,
      rewardPaymentAmount
    };
  }
}

const UserModel = getModelForClass(User, {
  schemaOptions: {
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

export default UserModel;
