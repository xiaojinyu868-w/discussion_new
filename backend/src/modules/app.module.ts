import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { SessionModule } from "./session/session.module";
import configuration from "../shared/configuration";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    SessionModule,
  ],
})
export class AppModule {}
