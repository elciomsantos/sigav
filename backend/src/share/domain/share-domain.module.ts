import { Module, Global } from "@nestjs/common";
import { ConfigModule } from "../../config/config.module";
import { DownloadLogModule } from "../../download-log/download-log.module";
import { ShareValidationService } from "./share-validation.service";
import { ShareTokenService } from "./share-token.service";
import { StreamViewCounterService } from "./stream-view-counter.service";

@Global()
@Module({
  imports: [ConfigModule, DownloadLogModule],
  providers: [
    ShareValidationService,
    ShareTokenService,
    StreamViewCounterService,
  ],
  exports: [
    ShareValidationService,
    ShareTokenService,
    StreamViewCounterService,
  ],
})
export class ShareDomainModule {}
