import { Request, Response, Router } from "express";
import { startSession } from "mongoose";
import BookingModel from "../models/Booking";
import CardModel from "../models/Card";
import PaymentModel from "../models/Payment";
import UserModel from "../models/User";
import { code2Session } from "../utils/byteDance";
import handleAsyncErrors from "../utils/handleAsyncErrors";
import { signToken } from "../utils/helper";
import HttpError from "../utils/HttpError";

export default (router: Router) => {
  router.route("/byte/login").post(
    handleAsyncErrors(async (req: Request, res: Response) => {
      const { code } = req.body;
      if (!code) throw new HttpError(400, "OAuth code missing.");
      const { openid, session_key, unionid } = await code2Session(code);

      let user = await UserModel.findOne({ openidByte: openid });
      if (user) {
        // user.set({ unionid });
        await user.save();
      } else {
        user = new UserModel();
        user.set({ openidByte: openid, registeredAt: "字节小程序" });
        await user.save();
      }

      console.log(`[BYT] Login ${user.id}, session_key: ${session_key}.`);

      res.json({
        user,
        token: user ? signToken(user) : null,
        session_key,
        openid
      });
    })
  );

  router.route("/byte/update-mobile").post(
    handleAsyncErrors(async (req: Request, res: Response) => {
      const { encryptedData, session_key, iv, openid } = req.body;
      if (!session_key || !encryptedData || !iv || !openid) {
        if (iv && encryptedData) {
          console.error(
            `[BYT] Update mobile failed, ${JSON.stringify(req.body)}`
          );
        }
        throw new HttpError(400, "获取手机号失败，请后台关闭小程序重新尝试");
      }
      // @ts-ignore
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
        console.log(`[BYT] Merge user ${openIdUser.id} to ${oldCustomer.id}.`);
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
        console.log(`[BYT] Update user mobile ${openIdUser.id} ${mobile}.`);
        openIdUser.set({ mobile });
        await openIdUser.save();
        res.json({
          user: openIdUser,
          token: signToken(openIdUser)
        });
      }
    })
  );

  return router;
};
