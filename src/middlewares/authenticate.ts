import HttpError from "../utils/HttpError";
import { getTokenData } from "../utils/helper";
import { Types } from "mongoose";
import UserModel from "../models/User";
import { NextFunction, Request, Response } from "express";

const { DEBUG } = process.env;

export default async function (
  req: Request,
  res: Response,
  next: NextFunction
) {
  const token = req.get("authorization") || req.query.token;

  if (DEBUG && token && token.length < 128) {
    const user = await UserModel.findOne({
      login: token.replace(/^Bearer /, "")
    });

    if (user) {
      req.user = user;
      return next();
    }
  }

  if (token) {
    try {
      const tokenData = getTokenData(token);
      const user = await UserModel.findById(tokenData.userId);
      if (user) req.user = user;
      else throw new Error("user_not_found");
    } catch (err) {
      return next(new HttpError(401, "无效登录，请重新登录"));
    }
  }

  if (
    !req.user &&
    ![
      "auth/login",
      "config(/.*)?",
      "store(/.*)?",
      "coupon(/.*)?",
      "card-type(/.*)?",
      "role(/.*)?",
      "post(/.*)?",
      "wechat.*",
      "wework.*",
      "youzan.*"
    ].some(pattern => {
      return req.path.match(`^/${pattern}$`);
    })
  ) {
    console.log(`[AUT] Blocked path without request user: ${req.path}.`);
    return next(new HttpError(401, "登录后才能访问此功能"));
  } else if (!req.user) {
    req.user = new UserModel({ _id: Types.ObjectId() });
  }

  next();
}
