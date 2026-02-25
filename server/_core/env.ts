export const ENV = {
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  adminPassword: process.env.ADMIN_PASSWORD ?? "",
  isProduction: process.env.NODE_ENV === "production",
  // AWS S3 for file storage
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
  awsRegion: process.env.AWS_REGION ?? "us-east-1",
  awsS3Bucket: process.env.AWS_S3_BUCKET ?? "",
  // AI / scraping
  openAiApiKey: process.env.OPENAI_API_KEY ?? "",
  jinaApiKey: process.env.JINA_API_KEY ?? "",
  vayneApiKey: process.env.VAYNE_API_KEY ?? "",
};

export const env = ENV;
