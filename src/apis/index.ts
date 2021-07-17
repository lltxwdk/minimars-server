import cors from "cors";
import methodOverride from "method-override";
// @ts-ignore
import Agendash from "agendash2";
import cookieSession from "cookie-session";
import authenticate from "../middlewares/authenticate";
import castEmbedded from "../middlewares/castEmbedded";
import AuthRouter from "./AuthRouter";
import BookingRouter from "./BookingRouter";
import CardTypeRouter from "./CardTypeRouter";
import CouponRouter from "./CouponRouter";
import ConfigRouter from "./ConfigRouter";
import EventRouter from "./EventRouter";
import FileRouter from "./FileRouter";
import GiftRouter from "./GiftRouter";
import PaymentRouter from "./PaymentRouter";
import PostRouter from "./PostRouter";
import StatsRouter from "./StatsRouter";
import StoreRouter from "./StoreRouter";
import UserRouter from "./UserRouter";
import WechatRouter from "./WechatRouter";
import CardRouter from "./CardRouter";
import detectUa from "../middlewares/detectUa";
import agenda from "../utils/agenda";
import { Express, NextFunction, Request, Response, Router } from "express";
import VisoRouter from "./VisoRouter";
import YouzanRouter from "./YouzanRouter";
import { Permission } from "../models/Role";
import RoleRouter from "./RoleRouter";
import WeworkRouter from "./WeworkRouter";

export default (app: Express, router: Router) => {
  // register routes
  [
    AuthRouter,
    BookingRouter,
    CardRouter,
    CardTypeRouter,
    CouponRouter,
    ConfigRouter,
    EventRouter,
    FileRouter,
    GiftRouter,
    PaymentRouter,
    PostRouter,
    RoleRouter,
    StatsRouter,
    StoreRouter,
    UserRouter,
    VisoRouter,
    WechatRouter,
    WeworkRouter,
    YouzanRouter
  ].forEach(R => {
    router = R(router);
  });

  app.use(
    "/api",
    cors({
      exposedHeaders: [
        "content-range",
        "accept-range",
        "items-total",
        "items-start",
        "items-end",
        "total-amount"
      ]
    }),
    methodOverride(),
    authenticate,
    castEmbedded,
    detectUa,
    router
  );

  app.use(
    "/agendash",
    cookieSession({
      name: "session",
      keys: [process.env.APP_SECRET || ""],

      // Cookie Options
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }),
    authenticate,
    function (req: Request, res: Response, next: NextFunction) {
      if (req.session?.authorized) {
        next();
      } else if (req.user.can(Permission.BOSSBOARD)) {
        next();
        req.session = { userId: req.user.id, authorized: true };
      } else {
        res.sendStatus(401);
      }
    },
    Agendash(agenda)
  );
};
