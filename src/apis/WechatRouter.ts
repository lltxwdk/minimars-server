import { Router } from "express";
import handleAsyncErrors from "../utils/handleAsyncErrors";
import User from "../models/User";
import { oAuth, pay } from "../utils/wechat";
import HttpError from "../utils/HttpError";
import { utils } from "@sigodenjs/wechatpay";
import { signToken } from "../utils/helper";
import Payment from "../models/Payment";
import Card, { CardStatus, userVisibleCardStatus } from "../models/Card";
import Booking from "../models/Booking";

export default (router: Router) => {
  router.route("/wechat/login").post(
    handleAsyncErrors(async (req, res) => {
      const { code } = req.body;
      if (!code) throw new HttpError(400, "OAuth code missing.");
      console.time("Wechat login");
      const userData = await oAuth.getUser(code);
      console.timeEnd("Wechat login");
      console.log("[WEC] Wechat login user data:", JSON.stringify(userData));

      const { openid, session_key, unionid } = userData;
      const user = await User.findOneAndUpdate(
        { openid },
        { unionid },
        { upsert: true, new: true }
      );

      console.log(`[WEC] Wechat login ${user.id}, session_key: ${session_key}`);

      res.json({
        user,
        token: user ? signToken(user) : null,
        session_key,
        openid
      });
    })
  );

  router.route("/wechat/signup").post(
    handleAsyncErrors(async (req, res) => {
      const { session_key, encryptedData, iv } = req.body;
      if (!session_key || !encryptedData || !iv) {
        console.error(
          `[WEC] Wechat signup failed, ${JSON.stringify(req.body)}`
        );
        throw new HttpError(400, "微信登录失败，请后台关闭小程序重新尝试");
      }

      const userData = oAuth.decrypt(encryptedData, session_key, iv);
      const {
        openId: openid,
        nickName,
        avatarUrl,
        gender,
        city,
        province,
        country
      } = userData;

      const user = await User.findOneAndUpdate(
        { openid },
        {
          openid,
          name: nickName,
          gender,
          avatarUrl,
          region: `${country} ${province} ${city}`
        },
        { upsert: true, new: true }
      );

      await user.save();

      res.json({
        user,
        token: signToken(user),
        openid,
        session_key
      });
    })
  );
  router.route("/wechat/update-mobile").post(
    handleAsyncErrors(async (req, res) => {
      const { encryptedData, session_key, iv, openid } = req.body;
      if (!session_key || !encryptedData || !iv || !openid) {
        console.error(
          `[WEC] Update mobile failed, ${JSON.stringify(req.body)}`
        );
        throw new HttpError(
          400,
          "微信获取手机号失败，请后台关闭小程序重新尝试"
        );
      }
      const { phoneNumber: mobile } = oAuth.decrypt(
        encryptedData,
        session_key,
        iv
      );
      if (!mobile) throw new HttpError(400, "数据解析异常");
      const oldCustomer = await User.findOne({ mobile });
      const openIdUser = await User.findOne({ openid });
      if (oldCustomer && oldCustomer.id !== openIdUser.id) {
        console.log(`[WEC] Merge user ${openIdUser.id} to ${oldCustomer.id}.`);
        const { openid, avatarUrl, gender, region } = openIdUser;
        oldCustomer.set({
          openid,
          avatarUrl,
          gender,
          region,
          mobile
        });
        await Booking.updateMany(
          { customer: openIdUser },
          { customer: oldCustomer }
        ).exec();
        await Card.updateMany(
          { customer: openIdUser },
          { customer: oldCustomer }
        ).exec();
        await Payment.updateMany(
          { customer: openIdUser },
          { customer: oldCustomer }
        ).exec();
        await openIdUser.remove();
        await oldCustomer.save();

        res.json({
          user: oldCustomer,
          token: signToken(oldCustomer)
        });
      } else {
        console.log(`[WEC] Update user mobile ${openIdUser.id} ${mobile}.`);
        openIdUser.set({ mobile });
        await openIdUser.save();
        res.json({
          user: openIdUser,
          token: signToken(openIdUser)
        });
      }
    })
  );
  router.route("/wechat/decrypt").post(
    handleAsyncErrors(async (req, res) => {
      const { encryptedData, session_key, iv } = req.body;
      if (!session_key || !encryptedData || !iv) {
        throw new HttpError(400, "微信信息解密失败");
      }
      const data = oAuth.decrypt(encryptedData, session_key, iv);
      res.json(data);
    })
  );

  router.route("/wechat/pay/notify").post(
    handleAsyncErrors(async (req, res) => {
      let data: any = await utils.fromXML(req.body);
      const returnData = await pay.payNotify(data, async parsedData => {
        const successData = {
          return_code: "SUCCESS",
          return_msg: "OK"
        };

        if (!pay.verifySign(parsedData)) {
          throw new Error("WechatPay sign error: " + parsedData.out_trade_no);
        }
        if (parsedData.result_code === "FAIL") {
          throw new Error("WechatPay error: " + parsedData.out_trade_no);
        }

        console.log(
          `[PAY] WechatPay success. Data: ${JSON.stringify(parsedData)}`
        );

        const payment = await Payment.findOne({ _id: parsedData.out_trade_no });

        console.log(`[PAY] Payment found, id: ${parsedData.out_trade_no}.`);

        if (!payment) {
          return {
            return_code: "FAIL",
            return_msg: `Payment id not found: ${parsedData.out_trade_no}.`
          };
        }

        if (payment.paid) {
          console.log(`[PAY] Payment ${payment._id} is paid before, skipped.`);
          return successData;
        }

        payment.paid = true;
        if (payment.attach.match(/^booking /)) {
          await payment.customer.addPoints(payment.amount);
        }
        Object.assign(payment.gatewayData, parsedData);

        await payment.save();

        return successData;
      });

      res.type("application/xml; charset=utf-8");
      res.end(returnData);
    })
  );
  return router;
};
