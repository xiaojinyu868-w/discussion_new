import { Module } from "@nestjs/common";
import { TingwuService } from "./tingwu.service";
import { AudioRelayService } from "./audio-relay.service";

@Module({
  providers: [TingwuService, AudioRelayService],
  exports: [TingwuService, AudioRelayService],
})
export class TingwuModule {}
