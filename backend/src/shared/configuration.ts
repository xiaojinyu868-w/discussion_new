export default () => {
  const region = process.env.TINGWU_REGION ?? "cn-beijing";
  const endpoint =
    process.env.TINGWU_ENDPOINT ?? `tingwu.${region}.aliyuncs.com`;

  return {
    tingwu: {
      region,
      accessKeyId: process.env.TINGWU_ACCESS_KEY_ID ?? "",
      accessKeySecret: process.env.TINGWU_ACCESS_KEY_SECRET ?? "",
      appKey: process.env.TINGWU_APP_KEY ?? "",
      endpoint,
    },
    pollingIntervalMs: Number(process.env.POLLING_INTERVAL_MS ?? 5000),
  };
};
