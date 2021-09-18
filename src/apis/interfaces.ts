import { Booking } from "../models/Booking";
import { PaymentGateway, Payment } from "../models/Payment";
import { Card } from "../models/Card";
import { CardType } from "../models/CardType";
import { Coupon } from "../models/Coupon";
import { Event } from "../models/Event";
import { Gift } from "../models/Gift";
import { Post } from "../models/Post";
import { Store } from "../models/Store";
import { User } from "../models/User";
import { Role } from "../models/Role";

export interface AuthLoginPostBody {
  login: string;
  password: string;
}

export interface AuthLoginResponseBody {
  token: string;
  user: User;
}

export interface WechatLoginPostBody {
  token: string;
}

export interface ListQuery {
  order?: string;
  limit?: number;
  skip?: number;
}

export interface AuthTokenUserIdResponseBody extends AuthLoginResponseBody {}

export interface BookingPostBody extends Partial<Booking> {}

export interface BookingPutBody extends Partial<Booking> {}

export interface BookingPostQuery {
  paymentGateway?: PaymentGateway;
  paymentGateways?: string;
  useBalance?: "false";
  customerKeyword?: string;
}

export interface BookingQuery extends ListQuery {
  status?: string; // support comma separated values
  customerKeyword?: string;
  type?: string;
  store?: string;
  date?: string;
  customer?: string;
  event?: string;
  gift?: string;
  coupon?: string;
  paymentType?: "guest" | "coupon" | "card";
}

export interface BookingPricePostBody extends Partial<Booking> {}

export interface CardPostBody extends Partial<Card> {}

export interface CardPutBody extends Partial<Card> {}

export interface CardPostQuery {
  paymentGateway?: PaymentGateway;
  atStore?: string;
}

export interface CardQuery extends ListQuery {
  status?: string; // support comma separated values
  customer?: string;
  title?: string;
  slug?: string;
  stores?: string;
  type?: string;
}

export interface CardTypePostBody extends Partial<CardType> {}

export interface CardTypePutBody extends Partial<CardType> {}

export interface CardTypeQuery extends ListQuery {
  include?: string;
  couponSlug?: string;
  slug?: string;
  type?: string;
  openForClient?: string;
  openForReception?: string;
  stores?: string;
  title?: string;
}

export interface CouponPostBody extends Partial<Coupon> {}

export interface CouponPutBody extends Partial<Coupon> {}

export interface CouponQuery extends ListQuery {
  enabled: "true" | "false";
  title: string;
  scene: string;
  stores: string;
}

export interface EventPostBody extends Partial<Event> {}

export interface EventPutBody extends Partial<Event> {}

export interface EventQuery extends ListQuery {
  keyword?: string;
  store?: string;
  tag?: string;
}

export interface GiftPostBody extends Partial<Gift> {}

export interface GiftPutBody extends Partial<Gift> {}

export interface GiftQuery extends ListQuery {
  keyword?: string;
  store?: string;
  isCover?: string;
}

export interface PaymentPostBody extends Partial<Payment> {}

export interface PaymentPutBody extends Partial<Payment> {}

export interface PaymentQuery extends ListQuery {
  date?: string;
  dateEnd?: string;
  dateType?: string;
  paid?: "false";
  refunded?: "true";
  customer?: string;
  attach?: string;
  title?: string;
  gateway?: PaymentGateway;
  direction?: "payment" | "refund";
  amount?: string;
  scene?: string;
  store?: string;
}

export interface PostPostBody extends Post {}

export interface PostPutBody extends Post {}

export interface PostQuery extends ListQuery {
  slug?: string;
  tag?: string;
}

export interface RolePostBody extends Role {}

export interface RolePutBody extends Role {}

export interface RoleQuery extends ListQuery {}

export interface StorePostBody extends Store {}

export interface StorePutBody extends Store {}

export interface StoreQuery extends ListQuery {}

export interface UserPostBody extends Partial<User> {}

export interface UserPutBody extends Partial<User> {}

export interface UserQuery extends ListQuery {
  keyword?: string;
  role?: string;
  membership?: "deposit"[];
  cardTypes?: string[];
  mobile?: string;
}
