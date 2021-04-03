// @ts-ignore
import WXOauth from "@xinglu/wxapp-oauth";
import { Pay, SignType, utils } from "@sigodenjs/wechatpay";
import fs from "fs";
import Axios, { AxiosRequestConfig } from "axios";
import { User } from "../models/User";
import { DocumentType } from "@typegoose/typegoose";

const appId = process.env.WEIXIN_APPID || "";
const secret = process.env.WEIXIN_SECRET || "";
const mchId = process.env.WEIXIN_MCH_ID || "";
const mchKey = process.env.WEIXIN_MCH_KEY || "";
const mchCertPath = process.env.WEIXIN_MCH_CERT_PATH || "";
const appIdMp = process.env.WEIXIN_APPID_MP || "";
const secretMp = process.env.WEIXIN_SECRET_MP || "";
const apiRoot = process.env.API_ROOT || "";
const accessToken = { token: "", expiresAt: 0 };
const accessTokenMp = { token: "", expiresAt: 0 };

const pfx = mchCertPath ? fs.readFileSync(mchCertPath) : Buffer.alloc(0);

export const oAuth = WXOauth({
  appid: appId,
  secret: secret
});
export const pay = new Pay({
  appId: appId,
  mchId: mchId,
  key: mchKey,
  pfx
});

function handleError(res: any) {
  if (!res || !res.data) {
    throw new Error("wechat_api_network_error");
  } else if (res.data.errcode) {
    console.error(`[WEC] Wechat API error: ${JSON.stringify(res.data)}.`);
    throw new Error("wechat_api_error");
  }
  return res.data;
}

async function request(
  isMp: boolean,
  path: string,
  data: any = null,
  config: AxiosRequestConfig = {}
) {
  const client = Axios.create({
    baseURL: "https://api.weixin.qq.com/cgi-bin/"
  });
  if (path !== "token") {
    client.interceptors.request.use(async (config: AxiosRequestConfig) => {
      if (!config.params) config.params = {};
      config.params.access_token = await getAccessToken(isMp);
      return config;
    });
  }
  let res: any;
  if (data) {
    res = await client.post(path, data, config);
  } else {
    res = await client.get(path, config);
  }
  return handleError(res);
}

export async function getAccessToken(isMp = false): Promise<string> {
  const at = isMp ? accessTokenMp : accessToken;
  if (at.expiresAt > Date.now()) {
    return at.token;
  }
  const data = await request(isMp, "token", null, {
    params: {
      grant_type: "client_credential",
      appid: isMp ? appIdMp : appId,
      secret: isMp ? secretMp : secretMp
    }
  });
  if (!data?.access_token) throw new Error("invalid_access_token");
  console.log(`[WEC] Get access token: ${JSON.stringify(data)}.`);
  at.token = data.access_token;
  at.expiresAt = Date.now() + 3.6e6;
  return at.token;
}

export async function getQrcode(
  path: string,
  output = "qrcode.jpg"
): Promise<void> {
  const data = await request(
    false,
    "wxaapp/createwxaqrcode",
    { path, width: 1280 },
    { responseType: "arraybuffer" }
  );
  if (data.errcode) {
    console.error(`[WEC] ${data.errcode} ${data.errmsg}.`);
    return;
  }
  const fileName = `${process.cwd()}/${output}`;
  console.log(fileName);
  fs.writeFileSync(fileName, data);
}

export async function getMpUserOpenids() {
  let nextOpenid = "";
  let openids: string[] = [];
  while (true) {
    const data = await request(true, "user/get", null, {
      params: { next_openid: nextOpenid }
    });
    openids = openids.concat(data.data.openid);
    if (data.count < 1e4) break;
    else nextOpenid = data.next_openid;
  }
  return openids;
}

enum SubscribeScene {
  ADD_SCENE_SEARCH = "ADD_SCENE_SEARCH",
  ADD_SCENE_ACCOUNT_MIGRATION = "ADD_SCENE_ACCOUNT_MIGRATION",
  ADD_SCENE_PROFILE_CARD = "ADD_SCENE_PROFILE_CARD",
  ADD_SCENE_QR_CODE = "ADD_SCENE_QR_CODE",
  ADD_SCENE_PROFILE_LINK = "ADD_SCENE_PROFILE_LINK",
  ADD_SCENE_PROFILE_ITEM = "ADD_SCENE_PROFILE_ITEM",
  ADD_SCENE_PAID = "ADD_SCENE_PAID",
  ADD_SCENE_WECHAT_ADVERTISEMENT = "ADD_SCENE_WECHAT_ADVERTISEMENT",
  ADD_SCENE_OTHERS = "ADD_SCENE_OTHERS"
}

interface UserInfo {
  subscribe: 0 | 1;
  openid: string;
  nickname: string;
  sex: 0 | 1 | 2;
  language: string;
  city: string;
  province: string;
  country: string;
  headimgurl: string;
  subscribe_time: number; // timestamp second
  unionid: string;
  remark: string;
  groupid: number;
  tagid_list: number[];
  subscribe_scene: SubscribeScene;
  qr_scene: number;
  qr_scene_str: string;
}

export async function getUsersInfo(openids: string[]) {
  const { user_info_list: usersInfo } = (await request(
    true,
    "user/info/batchget",
    {
      user_list: openids.map(openid => ({ openid, lang: "zh_CN" }))
    }
  )) as { user_info_list: UserInfo[] };
  return usersInfo;
}

export enum TemplateMessageType {
  WRITEOFF = "WRITEOFF",
  CANCEL = "CANCEL",
  GIFT_CARD_RECEIVED = "GIFT_CARD_RECEIVED"
}

export async function sendTemplateMessage(
  user: DocumentType<User>,
  type: TemplateMessageType,
  messages: string[]
) {
  if (
    !user.tags.includes("test") &&
    !process.env.ENABLE_WECHAT_TEMPLATE_MESSAGE
  ) {
    return;
  }
  if (!user.openidMp) {
    console.log(
      `[WEC] Fail to send template message without openidMp, user ${user.id}.`
    );
    return;
  }
  const templates = Object.values(TemplateMessageType).reduce(
    (templates, type) => {
      const template = process.env["WEIXIN_TEMPLATE_ID_" + type];
      if (!template) return templates;
      templates[type] = template;
      return templates;
    },
    {} as Record<TemplateMessageType, string>
  );

  const messageData: Record<string, { value: string; color?: string }> = {};

  messages.forEach((message, index) => {
    if (index === 0) {
      messageData.first = { value: message };
    } else if (index === messages.length - 1) {
      messageData.remark = { value: message, color: "#2f69c8" };
    } else {
      messageData["keyword" + index] = { value: message, color: "#18e245" };
    }
  });
  const postData = {
    touser: user.openidMp,
    template_id: templates[type],
    // url: "http://weixin.qq.com/download",
    miniprogram: {
      appid: appId,
      pagepath: "/pages/index/index"
    },
    data: messageData
  };
  await request(true, "message/template/send", postData);
  console.log(`[WEC] Send ${type} message to user ${user.mobile} ${user.id}.`);
}

export const unifiedOrder = async (
  outTradeNo: string,
  totalFee: number,
  openid: string,
  body: string = " ",
  attach: string = ""
) => {
  const orderData = await pay.unifiedOrder({
    body,
    attach,
    out_trade_no: outTradeNo,
    total_fee: Math.max(Math.round(totalFee * 100), 1),
    trade_type: "JSAPI",
    openid,
    notify_url: `${apiRoot}wechat/pay/notify`,
    spbill_create_ip: "8.8.8.8"
  });
  if (!pay.verifySign(orderData)) throw new Error("WechatPay sign error.");
  if (orderData.result_code === "FAIL")
    throw new Error(`Trade failed: ${JSON.stringify(orderData)}`);

  return orderData;
};

export const refundOrder = async (
  outTradeNo: string,
  outRefundNo: string,
  totalFee: number,
  refundFee: number
) => {
  console.log(
    `[PAY] Wechat refund ${outTradeNo} ${outRefundNo} ${totalFee} ${refundFee}`
  );
  return await pay.refund({
    out_trade_no: outTradeNo,
    out_refund_no: outRefundNo,
    total_fee: Math.max(Math.round(Math.abs(totalFee) * 100), 1),
    refund_fee: Math.max(Math.round(Math.abs(refundFee) * 100), 1)
  });
};

export const payArgs = (gatewayData: {
  nonce_str: string;
  prepay_id: string;
}) => {
  const timeStamp = String(Date.now()).substr(0, 10);
  const nonceStr = gatewayData.nonce_str;
  const _package = `prepay_id=${gatewayData.prepay_id}`;
  return {
    timeStamp,
    nonceStr,
    package: _package,
    paySign: utils.sign(
      "MD5" as SignType,
      {
        appId: appId,
        timeStamp,
        nonceStr,
        package: _package,
        signType: "MD5"
      },
      mchKey
    )
  };
};
