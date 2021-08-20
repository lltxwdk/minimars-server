import { Request, Response, Router } from "express";
import { startSession } from "mongoose";
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
  return router;
};
