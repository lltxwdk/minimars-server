import moment from "moment";
import BookingModel, { BookingStatus } from "../models/Booking";
import CardTypeModel from "../models/CardType";
import PaymentModel, { PaymentGateway, Scene } from "../models/Payment";
import StoreModel from "../models/Store";
import UserModel, { User } from "../models/User";
import agenda from "./agenda";
import Pospal from "./pospal";
import { getQrcode } from "./wechat";
import { getApprovalDetail } from "./wework";
import {
  getTrade,
  searchTrade,
  syncUserPoints,
  virtualCodeApply
} from "./youzan";

export default async function playground() {
  console.log("[DEV] Run playground...");
  try {
    // const user = await UserModel.findOne({ mobile: "13601881283" });
    // const pospal = new Pospal("TS");
    // const cats = await pospal.queryAllProductCategories();
    // const products = await pospal.queryAllProducts();
    // const menu = await pospal.getMenu();
    // console.log(JSON.stringify(menu));
    // pospal.addMember(user);
    // console.log(user.pospalId);
    // const customer = await pospal.getMember(user.pospalId);
    // await pospal.updateMemberBaseInfo(user.pospalId, { enable: 1 });
    // console.log(customer);
    // const store = await StoreModel.findOne({ code: "TS" });
    // await store.syncPospalTickets("2021-01-14", "2021-01-19");
    // const am = await pospal.queryAllPayMethod();
    // const em = [
    //   "payCode_103",
    //   "payCode_17",
    //   "payCode_105",
    //   "payCode_108",
    //   "payCode_111",
    //   "payCode_109",
    //   "payCode_107",
    //   "payCode_7",
    //   "payCode_106",
    //   "payCode_110",
    //   "payCode_2"
    // ];
    // console.log(
    //   am
    //     .filter(i => em.includes(i.code))
    //     .map(m => `${m.code} ${m.name}`)
    //     .join("\n")
    // );
    // const user = await UserModel.findOne({ mobile: "13641926334" });
    // syncUserPoints(user);
    // const trade = await getTrade("E20210313010129071404117");
    // console.log("trade:", JSON.stringify(trade));
    // console.log("trade:", trade.full_order_info);
    // if (trade.full_order_info.order_info.order_tags.is_virtual) {
    //   await virtualCodeApply(trade.full_order_info.order_info.tid);
    // }
    // console.log(
    //   JSON.parse(trade.full_order_info.orders[0].sku_properties_name).map(
    //     (p: any) => p.v
    //   )
    // );
    // const cardInfos = trade.full_order_info.orders.map(o => ({
    //   slug: o.outer_item_id,
    //   count: o.num
    // }));
    // for (const cardInfo of cardInfos) {
    //   for (let n = 0; n < cardInfo.count; n++) {}
    // }
    // searchTrade();
    // await saveSerialTableQrs("DY", "C", 32, 26);
    // await saveTableQr("TS", "大派对房", "1");
    // console.log(await new Pospal("TS").queryAllProductCategories());
    // const start = moment("2019-01-01");
    // while (start.toDate().valueOf() < new Date("2021/06/01").valueOf()) {
    //   await calCohort(start.format("Y-MM-DD"), "month");
    //   console.log("\n");
    //   start.add(1, "quarter");
    // }
    // const approval = await getApprovalDetail("202107170041");
    // console.log(JSON.stringify(approval));
  } catch (e) {
    console.error(e);
  }
}

async function saveSerialTableQrs(
  s: string,
  a: string,
  max: number,
  start = 1
) {
  for (let i = start; i <= max; i++) {
    await saveTableQr(s, a + "区", a + i);
  }
}

async function saveTableQr(s: string, a: string, t: string) {
  const code = `/pages/food/index?s=${s}&t=${a}.${t}`;
  const path = `${s}/${a}.${t}.jpg`;
  console.log(code, path);
  await getQrcode(code, path);
}

async function calCohort(startStr: string, tick: "month" | "quarter") {
  const start = moment(startStr);
  const end = start.clone().endOf(tick);
  const [{ users, visits, adults, kids }] = await BookingModel.aggregate([
    {
      $match: {
        type: Scene.PLAY,
        // card: { $ne: null },
        status: { $ne: BookingStatus.CANCELED },
        date: { $gte: start.format("Y-MM-DD"), $lte: end.format("Y-MM-DD") }
      }
    },
    {
      $group: {
        _id: null,
        users: { $addToSet: "$customer" },
        visits: { $sum: 1 },
        adults: { $sum: "$adultsCount" },
        kids: { $sum: "$kidsCount" }
      }
    }
  ]);

  let s = start;
  console.log(start.format("Y-MM-DD"), users.length, visits, adults, kids);
  while (s.toDate() < new Date("2021/07/01")) {
    s = s.add(1, tick);
    if (s.valueOf() >= new Date("2021/07/01").valueOf()) continue;
    const e = s.clone().endOf(tick);
    const [
      {
        users: returnUsers,
        visits: returnVisits,
        adults: returnAdults,
        kids: returnKids
      } = { users: [], visits: 0, adults: 0, kids: 0 }
    ] = await BookingModel.aggregate([
      {
        $match: {
          customer: { $in: users },
          type: Scene.PLAY,
          status: { $ne: BookingStatus.CANCELED },
          date: { $gte: s.format("Y-MM-DD"), $lte: e.format("Y-MM-DD") }
        }
      },
      {
        $group: {
          _id: null,
          users: { $addToSet: "$customer" },
          visits: { $sum: 1 },
          adults: { $sum: "$adultsCount" },
          kids: { $sum: "$kidsCount" }
        }
      }
    ]);
    console.log(
      s.format("Y-MM-DD"),
      returnUsers.length || 0,
      returnVisits || 0,
      returnAdults || 0,
      returnKids || 0
    );
  }
}
