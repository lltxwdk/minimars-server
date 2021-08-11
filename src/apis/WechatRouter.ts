import { Router, Request, Response } from "express";
import handleAsyncErrors from "../utils/handleAsyncErrors";
import UserModel from "../models/User";
import PaymentModel from "../models/Payment";
import CardModel from "../models/Card";
import BookingModel from "../models/Booking";
import { oAuth, pay } from "../utils/wechat";
import HttpError from "../utils/HttpError";
import { utils } from "@sigodenjs/wechatpay";
import { signToken } from "../utils/helper";

export default (router: Router) => {
  router.route("/wechat/login").post(
    handleAsyncErrors(async (req: Request, res: Response) => {
      const { code } = req.body;
      if (!code) throw new HttpError(400, "OAuth code missing.");

      const userData = await oAuth.getUser(code);
      // console.log("[WEC] Wechat login user data:", JSON.stringify(userData));

      const { openid, session_key, unionid } = userData;
      let user = await UserModel.findOne({ openid });
      if (user) {
        user.set({ unionid });
        await user.save();
      } else {
        user = new UserModel();
        user.set({ openid, unionid, registeredAt: "微信小程序" });
        await user.save();
      }

      console.log(
        `[WEC] Wechat login ${user.id}, session_key: ${session_key}.`
      );

      res.json({
        user,
        token: user ? signToken(user) : null,
        session_key,
        openid
      });
    })
  );

  router.route("/wechat/signup").post(
    handleAsyncErrors(async (req: Request, res: Response) => {
      const { session_key, encryptedData, iv } = req.body;
      if (!session_key || !encryptedData || !iv) {
        if (encryptedData && iv) {
          console.error(
            `[WEC] Wechat signup failed, ${JSON.stringify(req.body)}`
          );
        }
        throw new HttpError(400, "微信登录失败，请后台关闭小程序重新尝试");
      }

      const userData = oAuth.decrypt(encryptedData, session_key, iv);
      const { nickName, avatarUrl, gender, city, province, country } = userData;

      if (!req.user) {
        throw new HttpError(
          400,
          "Wechat getUserProfile requires authenticate."
        );
      }

      const user = req.user;

      const userInfo = {
        name: nickName,
        gender,
        avatarUrl,
        region: `${country} ${province} ${city}`
      };

      user.set(userInfo);
      await user.save();

      res.json({
        user,
        token: signToken(user),
        openid: user.openid,
        session_key
      });
    })
  );
  router.route("/wechat/update-mobile").post(
    handleAsyncErrors(async (req: Request, res: Response) => {
      const { encryptedData, session_key, iv, openid } = req.body;
      if (!session_key || !encryptedData || !iv || !openid) {
        if (iv && encryptedData) {
          console.error(
            `[WEC] Update mobile failed, ${JSON.stringify(req.body)}`
          );
        }
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
      const oldCustomer = await UserModel.findOne({ mobile });
      const openIdUser = await UserModel.findOne({ openid });
      if (!openIdUser) throw new Error("invalid_openid_user");
      if (oldCustomer && oldCustomer.id !== openIdUser.id) {
        console.log(`[WEC] Merge user ${openIdUser.id} to ${oldCustomer.id}.`);
        const { openid, unionid, avatarUrl, gender, region } = openIdUser;
        oldCustomer.set({
          openid,
          unionid,
          avatarUrl,
          gender,
          region,
          mobile
        });
        await BookingModel.updateMany(
          { customer: openIdUser },
          { customer: oldCustomer }
        ).exec();
        await CardModel.updateMany(
          { customer: openIdUser },
          { customer: oldCustomer }
        ).exec();
        await PaymentModel.updateMany(
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
    handleAsyncErrors(async (req: Request, res: Response) => {
      const { encryptedData, session_key, iv } = req.body;
      if (!session_key || !encryptedData || !iv) {
        throw new HttpError(400, "微信信息解密失败");
      }
      const data = oAuth.decrypt(encryptedData, session_key, iv);
      res.json(data);
    })
  );

  router.route("/wechat/pay/notify").post(
    handleAsyncErrors(async (req: Request, res: Response) => {
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
          `[PAY] WechatPay success. Data: ${JSON.stringify(parsedData)}.`
        );

        const payment = await PaymentModel.findOne({
          _id: parsedData.out_trade_no
        });

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

        Object.assign(payment.gatewayData, parsedData);

        await payment.save();

        // async trigger paidSuccess after
        payment.paidSuccess();

        return successData;
      });

      res.type("application/xml; charset=utf-8");
      res.end(returnData);
    })
  );
  return router;
};
