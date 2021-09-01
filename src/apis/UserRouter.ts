import { Router, Request, Response, NextFunction } from "express";
import paginatify from "../middlewares/paginatify";
import handleAsyncErrors from "../utils/handleAsyncErrors";
import parseSortString from "../utils/parseSortString";
import HttpError from "../utils/HttpError";
import UserModel, { User } from "../models/User";
import { hashPwd, isValidHexObjectId } from "../utils/helper";
// @ts-ignore
import idCard from "idcard";
import { UserQuery, UserPostBody, UserPutBody } from "./interfaces";
import { DocumentType } from "@typegoose/typegoose";
import { Permission } from "../models/Role";
import GiftModel from "../models/Gift";
import QRCode from "qrcode";

export default (router: Router) => {
  // User CURD
  router
    .route("/user")

    // create a user
    .post(
      handleAsyncErrors(async (req: Request, res: Response) => {
        const body = req.body as UserPostBody;
        if (!req.user.can(Permission.DEVELOP)) {
          (
            [
              "role",
              "openid",
              "cardType",
              "cardNo",
              "balanceDeposit",
              "balanceReward",
              "tags",
              "points"
            ] as Array<keyof User>
          ).forEach(f => {
            delete body[f];
          });
        }
        if (body.password) {
          body.password = await hashPwd(body.password);
        }
        if (body.mobile) {
          const userMobileExists = await UserModel.findOne({
            mobile: body.mobile
          });
          if (userMobileExists) {
            throw new HttpError(409, `手机号${body.mobile}已被使用.`);
          }
        }
        if (body.cardNo) {
          const userCardNoExists = await UserModel.findOne({
            cardNo: body.cardNo
          });
          if (userCardNoExists) {
            throw new HttpError(409, `会员卡号${body.cardNo}已被使用.`);
          }
        }
        const user = new UserModel(body);

        if (req.user.role && req.user.store) {
          user.registeredAt = req.user.store.name;
        }

        if (body.role) {
          await user.populate("role").execPopulate();
          if (!user.role) {
            throw new HttpError(400, "Invalid role.");
          }
        }

        if (
          !user.can(Permission.BOOKING_ALL_STORE) &&
          user.can(Permission.BOOKING_CREATE) &&
          !body.store
        ) {
          throw new HttpError(400, "该角色必须绑定门店");
        }

        if (body.idCardNo) {
          body.idCardNo = body.idCardNo.replace("*", "X").toUpperCase();
          const userIdCardNoExists = await UserModel.findOne({
            idCardNo: body.idCardNo
          });
          if (userIdCardNoExists) {
            throw new HttpError(409, `身份证号${body.idCardNo}已被使用.`);
          }
          const idCardInfo = idCard.info(body.idCardNo);
          if (!idCardInfo.valid) {
            throw new HttpError(400, `非法身份证号`);
          }
          user.gender = idCardInfo.gender === "M" ? "男" : "女";
          user.region = `${idCardInfo.province.text} ${idCardInfo.city.text} ${idCardInfo.area.text}`;
          user.constellation = idCardInfo.constellation;
          user.birthday = idCardInfo.birthday
            .toString()
            .replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
        }
        await user.save();

        user.password = undefined;

        res.json(user);
      })
    )

    // get all the users
    .get(
      paginatify,
      handleAsyncErrors(async (req: Request, res: Response) => {
        if (!req.user.can(Permission.CUSTOMER)) {
          throw new HttpError(403);
        }
        const queryParams = req.query as UserQuery;
        const { limit, skip } = req.pagination;
        const query = UserModel.find();
        const sort = parseSortString(queryParams.order) || {
          createdAt: -1
        };

        if (queryParams.keyword) {
          if (isValidHexObjectId(queryParams.keyword)) {
            query.where({ _id: queryParams.keyword });
          } else {
            query.where({
              $text: { $search: queryParams.keyword }
            });
          }
        }

        if (queryParams.role) {
          if (queryParams.role === "customer") {
            query.where({ role: null });
          } else if (queryParams.role === "staff") {
            query.where({ role: { $ne: null } });
          } else {
            query.where({ role: queryParams.role });
          }
        }

        if (queryParams.membership) {
          const membershipConditions = {
            deposit: { balanceDeposit: { $gt: 0 } }
          };
          query.where({
            $or: queryParams.membership.map(type => membershipConditions[type])
          });
        }

        if (queryParams.cardTypes) {
          query.where({ cardType: { $in: queryParams.cardTypes } });
        }

        (["mobile"] as Array<keyof UserQuery>).forEach(field => {
          if (queryParams[field]) {
            query.where({ [field]: queryParams[field] });
          }
        });

        let total = await query.countDocuments();

        if (queryParams.keyword) {
          // @ts-ignore
          query.projection({ score: { $meta: "textScore" } });
        }

        const page = await query
          .find()
          .sort(queryParams.keyword ? { score: { $meta: "textScore" } } : sort)
          .limit(limit)
          .skip(skip)
          .exec();

        if (skip + page.length > total) {
          total = skip + page.length;
        }

        res.paginatify(limit, skip, total).json(page);
      })
    );

  router
    .route("/user/:userId")

    .all(
      handleAsyncErrors(
        async (req: Request, res: Response, next: NextFunction) => {
          const user = await UserModel.findById(req.params.userId);
          if (
            !req.user.can(Permission.CUSTOMER) &&
            req.user.id !== req.params.userId
          ) {
            throw new HttpError(403);
          }
          if (!user) {
            throw new HttpError(404, `User not found: ${req.params.userId}`);
          }

          req.item = user;
          next();
        }
      )
    )

    // get the user with that id
    .get(
      handleAsyncErrors(async (req: Request, res: Response) => {
        const user = req.item;
        res.json(user);
      })
    )

    .put(
      handleAsyncErrors(async (req: Request, res: Response) => {
        const body = req.body as UserPutBody;
        if (!req.user.can(Permission.STAFF)) {
          delete body.role;
        }
        if (!req.user.can(Permission.CUSTOMER)) {
          delete body.tags;
        }
        if (!req.user.can(Permission.DEVELOP)) {
          (
            ["openid", "balanceDeposit", "balanceReward", "points"] as Array<
              keyof User
            >
          ).forEach(f => {
            delete body[f];
          });
        }
        if (!req.user.can(Permission.CUSTOMER)) {
          (["cardNo"] as Array<keyof User>).forEach(f => {
            delete body[f];
          });
        }
        const user = req.item as DocumentType<User>;
        if (body.password) {
          console.log(`[USR] User ${user.id} password reset.`);
          body.password = await hashPwd(body.password);
        }
        if (body.mobile) {
          const userMobileExists = await UserModel.findOne({
            mobile: body.mobile,
            _id: { $ne: user.id }
          });
          if (userMobileExists) {
            throw new HttpError(409, `手机号${body.mobile}已被使用`);
          }
        }
        if (body.cardNo) {
          const userCardNoExists = await UserModel.findOne({
            cardNo: body.cardNo,
            _id: { $ne: user.id }
          });
          if (userCardNoExists) {
            throw new HttpError(409, `会员卡号${body.cardNo}已被使用`);
          }
        }
        if (body.idCardNo) {
          body.idCardNo = body.idCardNo.replace("*", "X").toUpperCase();
          const userIdCardNoExists = await UserModel.findOne({
            idCardNo: body.idCardNo,
            _id: { $ne: user.id }
          });
          if (userIdCardNoExists) {
            throw new HttpError(409, `身份证号${body.idCardNo}已被使用`);
          }
        }
        if (body.isForeigner) {
          if (!body.country) {
            throw new HttpError(400, "外籍用户必须录入国籍");
          }
        }
        if (body.currentCover) {
          const cover = await GiftModel.findById(
            body.currentCover.id || body.currentCover
          );
          if (!cover || !cover.isProfileCover) {
            throw new HttpError(400, "不是有效的封面");
          }
          if (!req.user.covers.map(c => c.id).includes(cover.id)) {
            throw new HttpError(400, "客户还未兑换这个封面");
          }
        }

        user.set(body);

        if (body.idCardNo) {
          const idCardInfo = idCard.info(body.idCardNo);
          if (!idCardInfo.valid) {
            throw new HttpError(400, `非法身份证号`);
          }
          user.gender = idCardInfo.gender === "M" ? "男" : "女";
          user.region = `${idCardInfo.province.text} ${idCardInfo.city.text} ${idCardInfo.area.text}`;
          user.constellation = idCardInfo.constellation;
          user.birthday = idCardInfo.birthday
            .toString()
            .replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
        }

        await user.save();

        user.password = undefined;

        res.json(user);
      })
    )

    // delete the user with this id
    .delete(
      handleAsyncErrors(async (req: Request, res: Response) => {
        if (!req.user.can(Permission.STAFF)) {
          throw new HttpError(403);
        }
        const user = req.item as DocumentType<User>;
        await user.remove();
        res.end();
      })
    );

  router.route("/qrcode-image/:text").get(
    handleAsyncErrors(async (req: Request, res: Response) => {
      const base64 = await QRCode.toDataURL(req.params.text, {
        type: "image/png"
      });
      const img = Buffer.from(base64.split(",")[1], "base64");
      res.writeHead(200, {
        "Content-Type": "image/png"
      });
      res.end(img);
    })
  );

  return router;
};
