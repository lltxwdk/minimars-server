import { Router, Request, Response, NextFunction } from "express";
import paginatify from "../middlewares/paginatify";
import handleAsyncErrors from "../utils/handleAsyncErrors";
import parseSortString from "../utils/parseSortString";
import HttpError from "../utils/HttpError";
import StoreModel, { Store } from "../models/Store";
import { StoreQuery, StorePostBody, StorePutBody } from "./interfaces";
import { DocumentType } from "@typegoose/typegoose";
import { Permission } from "../models/Role";
import Pospal, { ProductInCustomerMenu } from "../utils/pospal";
import { config } from "../models/Config";
import agenda from "../utils/agenda";

export default (router: Router) => {
  // Store CURD
  router
    .route("/store")

    // create a store
    .post(
      handleAsyncErrors(async (req: Request, res: Response) => {
        if (!req.user.can(Permission.STORE)) {
          throw new HttpError(403);
        }
        const store = new StoreModel(req.body as StorePostBody);
        await store.save();
        res.json(store);
      })
    )

    // get all the stores
    .get(
      paginatify,
      handleAsyncErrors(async (req: Request, res: Response) => {
        const queryParams = req.query as StoreQuery;
        const { limit, skip } = req.pagination;
        const query = StoreModel.find();

        query.select("-content");

        const sort = parseSortString(queryParams.order) || {
          createdAt: -1
        };

        if (!req.user.role && !req.user.tags.includes("headquarter")) {
          query.where({ order: { $gte: 0 } });
        }

        let total = await query.countDocuments();
        const page = await query
          .find()
          .sort(sort)
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
    .route("/store/:storeId")

    .all(
      handleAsyncErrors(
        async (req: Request, res: Response, next: NextFunction) => {
          const store = await StoreModel.findById(req.params.storeId);
          if (!store) {
            throw new HttpError(404, `Store not found: ${req.params.storeId}`);
          }
          req.item = store;
          next();
        }
      )
    )

    // get the store with that id
    .get(
      handleAsyncErrors(async (req: Request, res: Response) => {
        const store = req.item;
        res.json(store);
      })
    )

    .put(
      handleAsyncErrors(async (req: Request, res: Response) => {
        if (!req.user.can(Permission.STORE)) {
          throw new HttpError(403);
        }
        const store = req.item as DocumentType<Store>;
        store.set(req.body as StorePutBody);
        await store.save();
        res.json(store);
      })
    )

    // delete the store with this id
    .delete(
      handleAsyncErrors(async (req: Request, res: Response) => {
        if (!req.user.can(Permission.STORE)) {
          throw new HttpError(403);
        }
        const store = req.item as DocumentType<Store>;
        await store.remove();
        res.end();
      })
    );

  router.route("/store/:storeId/food-menu").get(
    handleAsyncErrors(async (req: Request, res: Response) => {
      const store = await StoreModel.findById(req.params.storeId).select(
        "foodMenu"
      );
      if (!store) {
        throw new HttpError(404, `Store not found: ${req.params.storeId}`);
      }
      if (!store.foodMenu) {
        const pospal = new Pospal(store.code);
        const menu = await pospal.getMenu();
        store.foodMenu = menu;
        await store.save();
      }
      res.json(store.foodMenu);
    })
  );

  router
    .route("/store-menu")

    .get(
      handleAsyncErrors(async (req: Request, res: Response) => {
        let store: DocumentType<Store> | null = null;
        let tableId = "";
        if (req.query.qr) {
          const match = req.query.qr.match(/^.*?:\/\/(.*?)-.*qrc=(.*)$/);
          if (!match) {
            throw new HttpError(400, "二维码信息错误");
          }
          const [, pospalCode, tableIdEncoded] = match;
          tableId = decodeURIComponent(tableIdEncoded);
          store = await StoreModel.findOne({ pospalCode }).select(
            "name code phone address posterUrl foodMenu"
          );
        }
        if (req.query.storeCode !== undefined) {
          store = await StoreModel.findOne({
            code: req.query.storeCode
          }).select("name code phone address posterUrl foodMenu");
          tableId = req.query.tableId;
        }
        if (!store) {
          throw new HttpError(404, `Store not found.`);
        }
        if (
          process.env.DEBUG_FOOD_MENU ||
          !store.foodMenu ||
          !store.foodMenu.length
        ) {
          const pospal = new Pospal(store.code);
          const menu = await pospal.getMenu();
          store.foodMenu = menu;
          await store.save();
        }
        const menu = store.customerFoodMenu;
        const storeObject = store.toJSON();
        delete storeObject.foodMenu;
        delete storeObject.customerFoodMenu;
        res.json({
          store: storeObject,
          tableId,
          menu
        });
      })
    )
    .post(
      handleAsyncErrors(async (req: Request, res: Response) => {
        if (req.body.updateAll) {
          agenda.now("sync pospal menus", null);
        }
        res.end();
      })
    );

  return router;
};
