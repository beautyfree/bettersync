import { All, Controller, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { SyncService } from './sync.service'
import { toNodeHandler } from 'bettersync/node'

/**
 * SyncController — mounts the sync handler at POST /api/sync.
 *
 * Uses toNodeHandler to convert between Express req/res and Web API
 * Request/Response. The sync.handler does the actual work.
 */
@Controller('api/sync')
export class SyncController {
  private handler: (req: Request, res: Response) => Promise<void>

  constructor(private readonly syncService: SyncService) {
    this.handler = toNodeHandler(this.syncService.sync) as (
      req: Request,
      res: Response,
    ) => Promise<void>
  }

  @All()
  async handleSync(@Req() req: Request, @Res() res: Response) {
    return this.handler(req, res)
  }
}
