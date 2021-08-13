import ConfigModel, { Config } from "../models/Config";
import reduceConfig from "./reduceConfig";

const { DEBUG } = process.env;

export default async (config: Config) => {
  const existingConfig = reduceConfig(await ConfigModel.find());
  const initConfigItemsInsert = (Object.keys(initConfig) as Array<keyof Config>)
    .filter(key => existingConfig[key] === undefined)
    .map(initKey => ({ [initKey]: initConfig[initKey] }));
  if (initConfigItemsInsert.length) {
    await ConfigModel.insertMany(initConfigItemsInsert);
    console.log(
      `[CFG] ${initConfigItemsInsert.length} config items initialized.`
    );
  }
  Object.assign(config, ...initConfigItemsInsert, existingConfig);
  if (!DEBUG) {
    console.log("[CFG] Loaded:", JSON.stringify(config));
  }
};

const initConfig: Config = {
  sockPrice: 0,
  kidFullDayPrice: 248,
  extraParentFullDayPrice: 50,
  freeParentsPerKid: 1,
  appointmentDeadline: "16:00:00",
  eventHint: "",
  playHint: "",
  offWeekdays: [],
  onWeekends: [],
  bookableDays: 15,
  foodMenuOrder: { 饮品: 100 },
  specialOfferFoodNames: ["辣妈亲子套餐"],
  welcomeRewardCard: { slug: "welcome" },
  ipCharacters: [
    { name: "alfie", workshopName: "科学实验室", coverTextColor: "#646A6D" },
    {
      name: "armstrong",
      workshopName: "小小运动场",
      coverTextColor: "#F7F8F8"
    },
    { name: "edward", workshopName: "创意工作坊", coverTextColor: "#91FFAB" },
    { name: "puffy", workshopName: "帕妃工作室", coverTextColor: "#646A6D" }
  ]
};
