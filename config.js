const path = require("path");
const dotenv = require("dotenv");

const envFile =
  process.env.NODE_ENV === "production" ? ".env.production" : ".env.local";
dotenv.config({ path: path.resolve(__dirname, envFile) });

const config = {
  
  app: {
    port: process.env.PORT,
    env: process.env.NODE_ENV || "development",
    serverMode: process.env.SERVER_MODE || "auto",
    dbType: process.env.DB_TYPE,
  },
  mysql: {
    host: process.env.MYSQL_HOST || "localhost",
    port: parseInt(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  },
  mssql: {
    host: process.env.MSSQL_HOST || "localhost",
    port: parseInt(process.env.MSSQL_PORT) || 1433,
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
  },
  databases: {
    officers: process.env.MYSQL_DB_OFFICERS,
    wofficers: process.env.MYSQL_DB_WOFFICERS,
    ratings: process.env.MYSQL_DB_RATINGS,
    ratingsA: process.env.MYSQL_DB_RATINGS_A,
    ratingsB: process.env.MYSQL_DB_RATINGS_B,
    juniorTrainee: process.env.MYSQL_DB_JUNIOR_TRAINEE,
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    expiry: process.env.JWT_EXPIRY || "24h",
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || "7d",
    refreshSecret: process.env.JWT_REFRESH_SECRET,
  },
};

module.exports = config;
