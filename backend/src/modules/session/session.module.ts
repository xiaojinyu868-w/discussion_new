import { Module, forwardRef } from "@nestjs/common";
import { SessionController } from "./session.controller";
import { SessionService } from "./session.service";
import { TingwuModule } from "../tingwu/tingwu.module";
import { PollerModule } from "../task-poller/poller.module";

@Module({
  imports: [forwardRef(() => TingwuModule), forwardRef(() => PollerModule)],
  controllers: [SessionController],
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}
