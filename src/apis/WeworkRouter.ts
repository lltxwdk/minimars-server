import { Router, Request, Response } from "express";
import handleAsyncErrors from "../utils/handleAsyncErrors";
import crypto from "crypto";
import xml2js from "xml2js";
import {
  ApprovalNotify,
  ApprovalStatus,
  ApprovalStatusChangeEventText,
  getApprovalDetail,
  handleCancelBooking,
  sendMessage
} from "../utils/wework";

const {
  WEWORK_APPROVAL_ENCODEING_AES_KEY: aesKeyBase64 = "",
  WEWORK_APPROVAL_TEMPLATE_ID_CANCEL_BOOKING: templateIdCancelBooking = ""
} = process.env;

export default (router: Router) => {
  router
    .route("/wework/approval")
    .get(
      handleAsyncErrors(async (req: Request, res: Response) => {
        const { msg_signature, timestamp, nonce, echostr } = req.query;
        console.log(echostr);
        const { msg } = decryptData(Buffer.from(echostr, "base64"));
        res.send(msg);
      })
    )
    .post(
      handleAsyncErrors(async (req: Request, res: Response) => {
        const xml = Buffer.from(req.body).toString("utf-8");
        const { Encrypt: dataEncrypted } = await xml2js.parseStringPromise(
          xml,
          {
            explicitArray: false,
            explicitRoot: false
          }
        );
        const { msg } = decryptData(Buffer.from(dataEncrypted, "base64"));
        const notify = (await xml2js.parseStringPromise(msg, {
          explicitArray: false,
          explicitRoot: false
        })) as ApprovalNotify;
        console.log("[WCO] Approval notify:", JSON.stringify(notify));
        res.send("OK");
        const approval = await getApprovalDetail(notify.ApprovalInfo.SpNo);
        try {
          switch (notify.ApprovalInfo.TemplateId) {
            case templateIdCancelBooking: {
              await handleCancelBooking(approval, notify.AgentID);
              break;
            }
          }
        } catch (e) {
          console.error(`[WCO] ${e.message}`);
          if (
            [
              ApprovalStatusChangeEventText.SUBMITTED,
              ApprovalStatusChangeEventText.REJECTED
            ].includes(notify.ApprovalInfo.StatuChangeEvent)
          ) {
            sendMessage(
              [notify.ApprovalInfo.Applyer.UserId],
              +notify.AgentID,
              `你提交的审批信息有误，${e.message}`
            );
          }
          const nextRecord = approval.sp_record.find(
            r => r.sp_status === ApprovalStatus.SUBMITTED
          );
          if (nextRecord) {
            sendMessage(
              nextRecord?.details.map(d => d.approver.userid),
              +notify.AgentID,
              `该审批信息有误，${e.message}`
            );
          }
        }
      })
    );

  return router;
};

function decryptData(data: Buffer) {
  const aesKey = Buffer.from(aesKeyBase64, "base64");
  const iv = Buffer.from(aesKey).slice(0, 16);
  let decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, iv);

  // https://stackoverflow.com/questions/60080965/crypto-decipher-final-for-aes-256-cbc-algorithm-with-invalid-key-fails-with-ba
  decipher.setAutoPadding(false);

  let decrypted = decipher.update(data);
  const final = decipher.final();
  const decoded = Buffer.concat([decrypted, final]);
  const msgLength = decoded.readInt32BE(16);
  const msg = decoded.slice(20, 20 + msgLength).toString("utf-8");
  return { msg };
}
