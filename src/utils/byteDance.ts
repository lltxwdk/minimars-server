import Axios, { AxiosRequestConfig } from "axios";
import { sleep } from "./helper";

const appId = process.env.BYTE_APPID || "";
const secret = process.env.BYTE_SECRET || "";
const mchId = process.env.BYTE_MCH_ID || "";
const mchKey = process.env.BYTE_MCH_KEY || "";
const mchCertPath = process.env.BYTE_MCH_CERT_PATH || "";
const apiRoot = process.env.API_ROOT || "";
const accessToken = { token: "", expiresAt: 0 };

function handleError(res: any) {
  if (!res || !res.data) {
    throw new Error("byte_dance_api_network_error");
  } else if (res.data.errcode) {
    console.error(`[WEC] Byte Dance API error: ${JSON.stringify(res.data)}.`);
    throw new Error("byte_dance_api_error");
  }
  return res.data;
}

async function request(
  path: string,
  data: any = null,
  config: AxiosRequestConfig = {}
): Promise<any> {
  const client = Axios.create({
    baseURL: "https://developer.toutiao.com/api/apps/"
  });
  client.interceptors.request.use(async (config: AxiosRequestConfig) => {
    if (!config.params) config.params = {};
    config.params.appid = appId;
    config.params.secret = secret;
    if (config.url === "pay") {
      config.params.access_token = await getAccessToken();
    }
    return config;
  });
  let res: any;
  if (data) {
    res = await client.post(path, data, config);
  } else {
    res = await client.get(path, config);
  }
  if (res.data.errcode === 40001) {
    console.log("[WEC] Access token invalid, refresh and retry...");
    await sleep(2000);
    await getAccessToken(true);
    return await request(path, data, config);
  }
  return handleError(res);
}

export async function getAccessToken(force = false): Promise<string> {
  if (!force && accessToken.expiresAt > Date.now()) {
    return accessToken.token;
  }
  const data = await request("token", null, {
    params: {
      grant_type: "client_credential",
      appid: appId,
      secret: secret
    }
  });
  if (!data?.access_token) throw new Error("invalid_access_token");
  console.log(`[WEC] Get access token: ${JSON.stringify(data)}.`);
  accessToken.token = data.access_token;
  accessToken.expiresAt = Date.now() + data.expires_in * 1000 - 3e5;
  return accessToken.token;
}

export async function code2Session(code: string) {
  return await request("jscode2session", null, { params: { code } });
}
