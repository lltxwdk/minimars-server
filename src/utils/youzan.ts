// @ts-ignore
import { md5 } from "@sigodenjs/wechatpay/dist/utils";
import { DocumentType } from "@typegoose/typegoose";
import moment from "moment";
// @ts-ignore
import { token, client } from "youzanyun-sdk";
import BookingModel, { BookingStatus } from "../models/Booking";
import CardModel from "../models/Card";
import CardTypeModel from "../models/CardType";
import PaymentModel, { PaymentGateway, Scene } from "../models/Payment";
import StoreModel from "../models/Store";
import UserModel, { User } from "../models/User";
import { sleep } from "./helper";
const tokenExpireOffset = 3e5; // 5 minutes

export const accessToken = {
  token: "",
  expiresAt: new Date()
};

const clientId = process.env.YOUZAN_CLIENT_ID;
const clientSecret = process.env.YOUZAN_CLIENT_SECRET;
const grantId = process.env.YOUZAN_GRANT_ID;

export async function getAccessToken(forceRefresh = false) {
  if (
    !forceRefresh &&
    accessToken.token &&
    accessToken.expiresAt.valueOf() - Date.now() >= tokenExpireOffset
  ) {
    return accessToken.token;
  }
  const { data } = await token.get({
    authorize_type: "silent",
    client_id: clientId,
    client_secret: clientSecret,
    grant_id: grantId,
    refresh: false
  });
  if (!data.success) {
    throw new Error(data.message);
  }
  accessToken.token = data.data.access_token;
  accessToken.expiresAt = new Date(data.data.expires);
  console.log(`[YZN] Got access token, expires at ${accessToken.expiresAt}.`);
  return accessToken.token;
}

async function call(
  api: string,
  version: string,
  params: Record<string, any>
): Promise<Record<string, any>> {
  const token = await getAccessToken();
  try {
    const { data } = await client.call({
      api,
      version,
      token,
      params
    });
    if (data.gw_err_resp) {
      if (data.gw_err_resp.err_code === 4203) {
        console.error(`[YZN] Token invalid, refresh and retry in 5 seconds...`);
        await sleep(5000);
        await getAccessToken(true);
        return await call(api, version, params);
      }
      throw new Error(data.gw_err_resp.err_msg);
    }
    if (version >= "4.0.0") {
      if (!data.success) {
        throw new Error(data.message);
      }
      return data.data;
    } else if (version >= "3.0.0") {
      if (data.error_response) {
        throw new Error(data.error_response.msg);
      }
      return data.response;
    } else {
      if (!data.success) {
        throw new Error(data.message);
      }
      return data.data;
    }
  } catch (err) {
    console.error(`[YZN] API Error:`, err.message);
    throw new Error("youzan_api_error");
  }
}

export async function syncUserPoints(
  user: DocumentType<User>,
  reason = "积分同步"
) {
  if (!user.youzanId) {
    return;
  }
  const result = await call("youzan.crm.customer.points.sync", "4.0.0", {
    points: user.points,
    user: {
      account_type: 2, // 1:fans_id, 2:mobile, 3:open_user_id, 4:yzOpenId
      account_id: user.mobile
    },
    reason
  });
  if (result.is_success) {
    console.log(
      `[YZN] User points synchronized, ${user.points} ${user.mobile} ${user.id}.`
    );
  }
}

export function verifyPush(eventKey: string, entity: string) {
  return md5(clientId + entity + clientSecret) === eventKey;
}

export async function getTrade(tid: string) {
  const trade = await call("youzan.trade.get", "4.0.0", { tid });
  return trade;
}

export async function searchTrade(query = {}) {
  const { full_order_info_list } = await call(
    "youzan.trades.sold.get",
    "4.0.0",
    query
  );
  const trades = full_order_info_list.map((i: any) => i.full_order_info);
  return trades;
}

export async function virtualCodeApply(code: string) {
  const result = await call("youzan.trade.virtualcode.apply", "3.0.0", {
    code
  });
  if (!result.is_success) {
    console.log(`[YZN] Code apply failed: ${code}.`);
  }
  return result;
}

export async function handleAuthMobile(message: {
  mobile: string;
  yz_open_id: string;
}) {
  let user = await UserModel.findOne({ mobile: message.mobile });
  if (!user) {
    user = new UserModel();
    user.mobile = message.mobile;
    user.registeredAt = "有赞商城";
  }
  user.youzanId = message.yz_open_id;
  console.log(
    `[YZN] User ${user.mobile} is ${
      user.isNew ? "created" : "updated"
    } from Youzan.`
  );
  await user.save();
  if (user.points) {
    syncUserPoints(user);
  }
}

export async function handleTradePaid(trade: any) {
  const {
    full_order_info: {
      orders,
      buyer_info: { buyer_phone: mobile, yz_open_id: youzanId },
      order_info: { tid }
    }
  } = trade;
  const user = await UserModel.findOne({ mobile });
  if (user && !user.youzanId) {
    user.youzanId = youzanId;
    await user.save();
    console.log(
      `[YZN] User ${user.id} missing youzanId, set to ${user.youzanId}.`
    );
  }
  if (orders.every((o: any) => o.outer_item_id.match(/^card-/))) {
    await createCard(trade);
  } else if (orders.every((o: any) => !o.outer_item_id.match(/^card-/))) {
    await createBooking(trade);
  } else {
    console.error(`[YZN] Mix order received, tid: ${tid}.`);
  }
}

export async function handleTradeSuccess(message: { tid: string }) {
  const booking = await BookingModel.findOne({
    "providerData.provider": "youzan",
    "providerData.sn": message.tid
  });
  if (!booking) return;
  await booking.finish();
}

export async function handleTradeClose(message: {
  tid: string;
  close_type: number;
  update_time: string;
}) {
  const { tid, close_type, update_time } = message;

  if (close_type !== 2) return;

  const booking = await BookingModel.findOne({
    "providerData.provider": "youzan",
    "providerData.sn": tid
  });
  if (booking) {
    await booking.createRefundPayment();
    await booking.save();
  } else {
    const cards = await CardModel.find({
      "providerData.provider": "youzan",
      "providerData.tid": tid
    });
    console.log(`[YZN] Try refund card ${cards.map(c => c.id).join(", ")}.`);
    for (const card of cards) {
      await card.createRefundPayment();
      await card.save();
    }
  }
}

async function createBooking(trade: any) {
  const booking = new BookingModel();
  const {
    full_order_info: {
      buyer_info: { buyer_phone: mobile },
      order_info: { created, tid },
      orders
    }
  } = trade;
  let user = await UserModel.findOne({ mobile });
  if (!user) {
    user = new UserModel({ mobile, registeredAt: "有赞商城" });
    await user.save();
  }
  booking.set({
    type: Scene.MALL,
    date: created.substr(0, 10),
    checkInAt: parseDateStr(created).format("YYYY-MM-DD HH:mm:ss"),
    customer: user,
    providerData: { provider: "youzan", sn: tid, ...trade },
    status: BookingStatus.BOOKED,
    remarks: orders.map((o: any) => `${o.title}×${o.num}`).join("、")
  });

  try {
    await booking.save();
  } catch (err) {
    if (err.code === 11000) {
      // silent on dup provider order, skip payment creating
      return;
    } else {
      throw err;
    }
  }

  const { totalFee, totalPointsPrice } = orders.reduce(
    (acc: { totalFee: number; totalPointsPrice: number }, order: any) => {
      if (order.total_fee) {
        acc.totalFee = +(+order.total_fee + acc.totalFee).toFixed(10);
      }
      if (order.points_price) {
        acc.totalPointsPrice = +(
          +order.points_price + acc.totalPointsPrice
        ).toFixed(10);
      }
      return acc;
    },
    { totalFee: 0, totalPointsPrice: 0 }
  );

  if (totalFee) {
    const totalFeePayment = new PaymentModel();
    totalFeePayment.set({
      scene: Scene.MALL,
      customer: user,
      gateway: PaymentGateway.Mall,
      booking,
      title: orders.map((o: any) => o.title).join(", "),
      amount: totalFee,
      assets: totalFee,
      revenue: totalFee
    });
    await totalFeePayment.save();
  }

  await user.addPoints(totalFee);

  if (totalPointsPrice) {
    const totalPointsPayment = new PaymentModel();
    totalPointsPayment.set({
      scene: Scene.MALL,
      customer: user,
      gateway: PaymentGateway.Points,
      booking,
      title: orders.map((o: any) => o.title).join(", "),
      amount: 0,
      amountInPoints: totalPointsPrice
    });
    await totalPointsPayment.save();
  }
}

async function createCard(trade: any) {
  const {
    full_order_info: {
      order_info: { tid },
      buyer_info: { buyer_phone: mobile },
      orders
    }
  } = trade;
  const stores = await StoreModel.find();
  let user = await UserModel.findOne({ mobile });
  if (!user) {
    user = new UserModel({ mobile, registeredAt: "有赞商城" });
    await user.save();
  }

  for (const order of orders) {
    if (!order.outer_item_id.match(/^card-/)) continue;
    const slug = order.outer_item_id.replace(/^card-/, "");
    const num = order.num;
    const storeNames = JSON.parse(order.sku_properties_name)
      .filter((p: any) => p.k && p.k.includes("门店"))
      .map((p: any) => p.v);
    const price = order.discount_price;
    console.log(
      `[YZN] Try create card ${slug} × ${num} @ ${
        storeNames.join(",") || "all"
      } for user ${user.mobile} ${user.id}.`
    );
    const cardType = await CardTypeModel.findOne({ slug });
    if (!cardType) continue;
    for (let n = 0; n < num; n++) {
      const card = cardType.issue(user);
      if (storeNames.length) {
        card.stores = stores.filter(store =>
          storeNames.some((s: string) => store.name.includes(s.substr(0, 2)))
        );
      }
      card.providerData = {
        provider: "youzan",
        sn: orders.oid,
        tid,
        ...order
      };
      await card.createPayment({ paymentGateway: PaymentGateway.Mall }, price);
      await card.save();

      console.log(
        `[YZN] Auto created card ${slug} ${card.title} ${card.id} for user ${user.mobile} ${user.id}.`
      );
    }
  }
  sleep(5000).then(async () => {
    try {
      await virtualCodeApply(tid);
      console.log("[YZN] Code applied:", tid);
    } catch (e) {
      //
    }
  });
}

function parseDateStr(str: string) {
  str = str.replace("+", " ");
  return moment(str);
}
