import { DocumentType } from "@typegoose/typegoose";
import WebSocket, { Server } from "ws";
import { Store, FaceDevice } from "../models/Store";

type Target = WebSocket | FaceDevice | Store;

function isFaceDevice(t: Target): t is FaceDevice {
  return (t as FaceDevice).mac !== undefined;
}

function isStore(t: Target): t is DocumentType<Store> {
  const s = t as DocumentType<Store>;
  return s._id;
}

export default class Viso {
  devices: FaceDevice[] = [];
  stores: Store[] = [];
  init(wss: Server, stores: Store[]) {
    stores.forEach(store => {
      this.devices = this.devices.concat(
        store.faceDevices.map(d => {
          d.storeCode = store.code;
          return d;
        })
      );
    });
    this.stores = stores;
    wss.on("connection", ws => {
      this.getDeviceInfo(ws);
      ws.on("message", msg => {
        const parsed = JSON.parse(msg.toString());
        this.onReturn(
          ws,
          parsed.data.payload.command,
          parsed.data.payload.data
        );
      });
    });
  }

  sendCommand(target: Target, path: string, payload = {}) {
    let devices: FaceDevice[] = [];
    if (isFaceDevice(target)) {
      if (!target.ws) {
        console.error(
          `[VSO] Face device ${target.name} websocket not connected.`
        );
        return;
      }
      devices.push(target);
    } else if (isStore(target)) {
      const store = this.stores.find(s => s.code === target.code);
      store.faceDevices.forEach(device => {
        if (!device.ws) {
          console.error(
            `[VSO] Store ${target.code} face device ${device.name} websocket not connected.`
          );
          return;
        }
        devices.push(device);
      });
    } else {
      devices.push(Object.assign(new FaceDevice(), { ws: target }));
    }

    devices.forEach(device => {
      if (!device.ws)
        console.error(
          `[VSO] Face device ${device.name} websocket not connected.`
        );
      device.ws.send(
        JSON.stringify({
          command: "http_request",
          timeStamp: (Date.now() / 1000).toFixed(),
          mac: target instanceof WebSocket ? undefined : device.mac,
          data: {
            url: "api/v1/face/" + path,
            payload
          }
        })
      );
    });
  }

  onReturn(ws: WebSocket, command: Command, payload: any = {}) {
    console.log("[VSO] On return", Command[command], payload);
    switch (command) {
      case Command.GET_DEVICE_INFO:
        const device = this.devices.find(d => d.mac === payload.mac);
        if (!device) {
          console.error(
            `[VSO] Face device ${payload.mac} is not registered under store.`
          );
        }
        device.ws = ws;
        console.log(
          `[VSO] Face device ${device.storeCode} ${device.name} connected.`
        );
        this.resetPersons(device);
        break;
    }
  }

  getDeviceInfo(ws: WebSocket) {
    this.sendCommand(ws, "getDeviceInfo");
  }

  addPerson(
    target: Target,
    userId: string,
    images: string[],
    name: string = "",
    age: number = 0,
    gender: "male" | "female" = "male",
    phone = "10000000000",
    email = "face@minmi-mars.com"
  ) {
    this.sendCommand(target, "addPerson", {
      userId,
      name,
      age,
      gender,
      phone,
      email,
      images: images.map(data => ({ data })),
      accessInfo: {}
    });
  }

  queryPerson(target: Target) {
    this.sendCommand(target, "queryPerson");
  }

  addFaces(target: Target, personId: string, images: string[]) {
    this.sendCommand(target, "addFaces", {
      personId,
      images: images.map(data => ({ data }))
    });
  }

  resetPersons(target: Target) {
    this.sendCommand(target, "resetPersons");
  }
}

enum Command {
  GET_DEVICE_INFO = 127
}

export const viso = new Viso();