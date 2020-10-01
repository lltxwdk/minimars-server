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

export interface AuthLoginPostBody {
  login: string;
  password: string;
}

export interface AuthLoginResponseBody {
  token: string;
  user: User;
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

export interface BookingPriceResponseBody {
  price: number;
  priceInPoints?: number;
}

export interface CardPostBody extends Partial<Card> {}

export interface CardPutBody extends Partial<Card> {}

export interface CardPostQuery {
  paymentGateway?: PaymentGateway;
}

export interface CardQuery extends ListQuery {
  status?: string; // support comma separated values
  customer?: string;
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
  store?: string;
}

export interface CouponPostBody extends Partial<Coupon> {}

export interface CouponPutBody extends Partial<Coupon> {}

export interface CouponQuery extends ListQuery {
  enabled: "true" | "false";
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
}

export interface PaymentPostBody extends Partial<Payment> {}

export interface PaymentPutBody extends Partial<Payment> {}

export interface PaymentQuery extends ListQuery {
  date?: string;
  dateEnd?: string;
  paid?: "false";
  customer?: string;
  attach?: string;
  title?: string;
  gateway?: PaymentGateway;
  direction?: "payment" | "refund";
  amount?: string;
}

export interface PostPostBody extends Post {}

export interface PostPutBody extends Post {}

export interface PostQuery extends ListQuery {
  slug?: string;
  tag?: string;
}

export interface StorePostBody extends Store {}

export interface StorePutBody extends Store {}

export interface StoreQuery extends ListQuery {}

export interface UserPostBody extends User {}

export interface UserPutBody extends User {}

export interface UserQuery extends ListQuery {
  keyword: string;
  role: string;
  membership: string[];
  cardTypes: string[];
}
