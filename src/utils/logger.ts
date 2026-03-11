import winston from "winston";

const { combine, timestamp, errors, json, colorize, printf } = winston.format;

const isDev = process.env.NODE_ENV !== "production";

const devFormat = combine(
  colorize(),
  timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, ...meta }) => {
    const metaStr = Object.keys(meta).length
      ? ` ${JSON.stringify(meta, null, 2)}`
      : "";
    return `${ts} [${level}] ${message}${metaStr}`;
  })
);

const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  format: isDev ? devFormat : prodFormat,
  defaultMeta: { service: "hlb-sf-user-sync" },
  transports: [
    new winston.transports.Console(),
  ],
});

export default logger;
