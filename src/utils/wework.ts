import Axios, { AxiosRequestConfig } from "axios";
import { isValidObjectId } from "mongoose";
import BookingModel, { BookingStatus } from "../models/Booking";
import { Scene } from "../models/Payment";
import { isValidHexObjectId, sleep } from "./helper";

const corpId = process.env.WEWORK_CORP_ID || "";
const approvalSecret = process.env.WEWORK_APPROVAL_SECRET || "";
const accessToken = { token: "", expiresAt: 0 };

function handleError(res: any) {
  if (!res || !res.data) {
    throw new Error("wechat_api_network_error");
  } else if (res.data.errcode) {
    console.error(`[WCO] Wework API error: ${JSON.stringify(res.data)}.`);
    throw new Error("wework_api_error");
  }
  return res.data;
}

async function request(
  path: string,
  data: any = null,
  config: AxiosRequestConfig = {}
): Promise<any> {
  const client = Axios.create({
    baseURL: "https://qyapi.weixin.qq.com/cgi-bin/"
  });
  if (path !== "gettoken") {
    client.interceptors.request.use(async (config: AxiosRequestConfig) => {
      if (!config.params) config.params = {};
      config.params.access_token = await getAccessToken();
      return config;
    });
  }
  let res: any;
  if (data) {
    res = await client.post(path, data, config);
  } else {
    res = await client.get(path, config);
  }
  if (res.data.errcode === 40001) {
    console.log("[WCO] Access token invalid, refresh and retry...");
    await sleep(2000);
    await getAccessToken(true);
    return await request(path, data, config);
  }
  return handleError(res);
}

export async function getAccessToken(force = false): Promise<string> {
  if (!force && accessToken.expiresAt > Date.now()) {
    return accessToken.token;
  }
  const data = await request("gettoken", null, {
    params: {
      corpid: corpId,
      corpsecret: approvalSecret
    }
  });
  if (!data?.access_token) throw new Error("invalid_access_token");
  console.log(`[WCO] Get access token: ${JSON.stringify(data)}.`);
  accessToken.token = data.access_token;
  accessToken.expiresAt = Date.now() + data.expires_in * 1000 - 3e5;
  return accessToken.token;
}

export async function getApprovalDetail(spNo: string) {
  const res = await request("oa/getapprovaldetail", { sp_no: spNo });
  const approval = new ApprovalDetail();
  Object.assign(approval, res.info);
  return approval;
}

export async function sendMessage(
  userId: string[],
  agentId: number,
  content: string,
  type = "text"
) {
  console.log(`[WCO] Send ${type} message: ${content}.`);
  await request("message/send", {
    touser: userId.join("|"),
    type,
    agentid: agentId,
    text: { content },
    msgtype: type
  });
}

export async function handleCancelBooking(
  approval: ApprovalDetail,
  agentId: string
) {
  const bookingId = approval.getTextField("系统订单号");
  if (!isValidHexObjectId(bookingId || "")) {
    throw new Error(`“${bookingId}”不是有效的订单号`);
  }
  const mobile = approval.getTextField("客人手机号");
  const booking = await BookingModel.findById(bookingId);
  if (!booking) {
    throw new Error(`查询不到订单“${bookingId}”`);
  }
  if (booking.customer?.mobile !== mobile) {
    throw new Error(`客人手机号${mobile || ""}校验失败，订单和手机号不匹配`);
  }
  if (
    booking.status !== BookingStatus.PENDING_REFUND &&
    booking.type === Scene.PLAY
  ) {
    throw new Error(`订单状态不是“待退款”`);
  }
  if (approval.sp_status === ApprovalStatus.APPROVED) {
    await booking.cancel();
    sendMessage(
      [approval.applyer.userid],
      +agentId,
      `你的审批单号${approval.sp_no}，订单已撤销`
    );
  }
}

export enum ApprovalStatusText {
  SUBMITTED = "1",
  APPROVED = "2",
  REVOKED = "4"
}

export enum ApprovalStatusChangeEventText {
  SUBMITTED = "1",
  APPROVED = "2",
  REJECTED = "3",
  REVOKED = "6"
}

export enum ApprovalStatus {
  SUBMITTED = 1,
  APPROVED = 2,
  REVOKED = 4
}

export interface Notify {
  ToUserName: string;
  FromUserName: string;
  CreateTime: string;
  MsgType: string;
  Event: string;
  AgentID: string;
}

export interface ApprovalNotify extends Notify {
  ApprovalInfo: {
    SpNo: string;
    SpName: string;
    SpStatus: ApprovalStatusText;
    TemplateId: string;
    ApplyTime: string;
    Applyer: { UserId: string; Party: string };
    // SpRecord: {
    //   SpStatus: ApprovalStatusText;
    //   ApproverAttr: string;
    //   Details: {
    //     Approver: { UserId: string };
    //     Speech: string;
    //     SpStatus: ApprovalStatusText;
    //     SpTime: string;
    //   };
    // };
    // Notifyer: { UserId: string }[];
    StatuChangeEvent: ApprovalStatusChangeEventText;
  };
}

type Control = "Number" | "Selector" | "Text" | "File" | "Money";

export class ApprovalDetail {
  sp_no!: string;
  sp_name!: string;
  sp_status!: ApprovalStatus;
  template_id!: string;
  apply_time!: number; // timestamp seconds
  applyer!: { userid: string; partyid: string };
  sp_record!: {
    sp_status: ApprovalStatus;
    approverattr: number;
    details: {
      approver: { userid: string };
      speech: string;
      sp_status: ApprovalStatus;
      sptime: number;
      media_id: [];
    }[];
  }[];
  notifyer!: { userid: string }[];
  apply_data!: {
    contents: [
      {
        control: Control;
        id: string;
        title: { text: string; lang: string }[];
        value: {
          tips: [];
          members: [];
          departments: [];
          files: []; // control:"File"
          children: [];
          stat_field: [];
          new_number: string; // control:"Number"
          new_money: string; // control:"Money"
          text: string; // control:"Text"
          selector: {
            // control:"Select"
            type: "single";
            options: {
              key: string;
              value: { text: string; lang: string }[];
            }[];
          };
          sum_field: [];
          related_approval: [];
          students: [];
          classes: [];
        };
      }
    ];
  };
  getField(field: string, control: Control) {
    return this.apply_data.contents.find(
      content =>
        content.control === control && content.title.some(t => t.text === field)
    );
  }
  getTextField(field: string) {
    const content = this.getField(field, "Text");
    return content?.value.text;
  }
  getNumberField(field: string) {
    const content = this.getField(field, "Number");
    return content?.value.new_number;
  }
  getSingleSelectField(field: string) {
    const content = this.getField(field, "Text");
    return content?.value.selector.options[0].value.find(
      v => v.lang === "zh_CN"
    )?.text;
  }
  comments!: [];
}
