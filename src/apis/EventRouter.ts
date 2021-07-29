import { Router, Request, Response, NextFunction } from "express";
import paginatify from "../middlewares/paginatify";
import handleAsyncErrors from "../utils/handleAsyncErrors";
import parseSortString from "../utils/parseSortString";
import HttpError from "../utils/HttpError";
import BookingModel, { validBookingStatus } from "../models/Booking";
import EventModel, { Event } from "../models/Event";
import { EventPostBody, EventPutBody, EventQuery } from "./interfaces";
import { DocumentType } from "@typegoose/typegoose";
import escapeStringRegexp from "escape-string-regexp";
import { Permission } from "../models/Role";

export default (router: Router) => {
  // Event CURD
  router
    .route("/event")

    // create an event
    .post(
      handleAsyncErrors(async (req: Request, res: Response) => {
        if (!req.user.can(Permission.EVENT)) {
          throw new HttpError(403);
        }
        const event = new EventModel(req.body as EventPostBody);
        if (event.price === undefined && event.priceInPoints === undefined) {
          throw new HttpError(400, "积分和收款售价必须至少设置一项");
        }
        await event.save();
        res.json(event);
      })
    )

    // get all the events
    .get(
      paginatify,
      handleAsyncErrors(async (req: Request, res: Response) => {
        const queryParams = req.query as EventQuery;
        const { limit, skip } = req.pagination;
        const query = EventModel.find().populate("customer");
        const sort = parseSortString(queryParams.order) || {
          order: -1,
          date: -1,
          createdAt: -1
        };
        query.select("-content");

        if (!req.user.can(Permission.BOOKING_ALL_STORE)) {
          query.find({ $or: [{ store: req.user.store?.id }, { store: null }] });
        }

        if (!req.user.role) {
          query.find({ order: { $gte: 0 } });
        }

        if (queryParams.keyword) {
          query.find({
            title: new RegExp(escapeStringRegexp(queryParams.keyword), "i")
          });
        }

        if (queryParams.store) {
          query.where({ $or: [{ store: queryParams.store }, { store: null }] });
        }

        if (queryParams.tag) {
          query.find({ tags: queryParams.tag });
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
    .route("/event/:eventId")

    .all(
      handleAsyncErrors(
        async (req: Request, res: Response, next: NextFunction) => {
          const event = await EventModel.findById(req.params.eventId);
          if (!event) {
            throw new HttpError(404, `Event not found: ${req.params.eventId}`);
          }
          req.item = event;
          next();
        }
      )
    )

    // get the event with that id
    .get(
      handleAsyncErrors(async (req: Request, res: Response) => {
        const event = req.item;
        res.json(event);
      })
    )

    .put(
      handleAsyncErrors(async (req: Request, res: Response) => {
        if (!req.user.can(Permission.EVENT)) {
          throw new HttpError(403);
        }
        const event = req.item as DocumentType<Event>;
        event.set(req.body as EventPutBody);
        if (event.kidsCountMax) {
          // re-calculate kidsCountLeft
          const eventBookings = await BookingModel.find({
            event,
            status: { $in: validBookingStatus }
          });
          event.kidsCountLeft =
            event.kidsCountMax -
            eventBookings.reduce(
              (kidsCount, booking) => kidsCount + (booking.kidsCount || 0),
              0
            );
          if (event.kidsCountLeft < 0) {
            throw new HttpError(400, "剩余名额不能为负数");
          }
        }
        await event.save();
        res.json(event);
      })
    )

    // delete the event with this id
    .delete(
      handleAsyncErrors(async (req: Request, res: Response) => {
        if (!req.user.can(Permission.EVENT)) {
          throw new HttpError(403);
        }
        const event = req.item as DocumentType<Event>;
        const bookingCount = await BookingModel.countDocuments({
          event: event.id
        });

        if (bookingCount > 0) {
          throw new HttpError(400, "已经存在报名记录，不能删除");
        }

        await event.remove();

        res.end();
      })
    );

  return router;
};
