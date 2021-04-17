import { Response } from 'express';
import { Brackets, getConnection, getManager, In } from 'typeorm';
import {
  ApiRequest, OrgParam,
} from '../index';
import { OrphanedRecord } from './orphaned-record.model';
import { ActionType, OrphanedRecordAction } from './orphaned-record-action.model';
import { Org } from '../org/org.model';
import { BadRequestError, InternalServerError } from '../../util/error-types';
import { convertDateParam, reingestByDocumentId } from '../../util/reingest-utils';
import { RosterHistory } from '../roster/roster-history.model';
import { RosterEntryData } from '../roster/roster.controller';
import { addRosterEntry } from '../../util/roster-utils';
import { Roster } from '../roster/roster.model';

interface OrphanedRecordResult {
  id: string;
  edipi: string;
  phone: string;
  unit: string;
  count: number;
  action?: string;
  claimedUntil?: Date;
  latestReportDate: Date;
  earliestReportDate: Date;
  unitId?: number;
  rosterHistoryId?: number;
}

function getVisibleOrphanedRecordResults(userEdipi: string, orgId: number) {
  const params = {
    now: new Date(),
    orgId,
    userEdipi,
  };

  const rosterEntries = RosterHistory.createQueryBuilder('rh')
    .leftJoin('rh.unit', 'u')
    .select('rh.id', 'id')
    .addSelect('rh.edipi', 'edipi')
    .addSelect('rh.timestamp', 'timestamp')
    .addSelect('rh.change_type', 'change_type')
    .addSelect('rh.unit_id', 'unit_id')
    .where('u.org_id = :orgId', { orgId })
    .distinctOn(['rh.unit_id', 'rh.edipi'])
    .orderBy('rh.unit_id')
    .addOrderBy('rh.edipi', 'DESC')
    .addOrderBy('rh.timestamp', 'DESC')
    .addOrderBy('rh.change_type', 'DESC');

  return OrphanedRecord
    .createQueryBuilder('orphan')
    .leftJoin(OrphanedRecordAction, 'action', `action.id=orphan.composite_id AND (action.expires_on > :now OR action.expires_on IS NULL) AND (action.type='claim' OR (action.user_edipi=:userEdipi AND action.type='ignore'))`, params)
    .leftJoin(`(${rosterEntries.getQuery()})`, 'roster', 'orphan.edipi = roster.edipi')
    .where('orphan.org_id=:orgId', params)
    .andWhere('orphan.deleted_on IS NULL')
    .andWhere('roster.change_type IS NULL OR (roster.change_type <> \'deleted\')')
    .andWhere(`(action.type IS NULL OR (action.type='claim' AND action.user_edipi=:userEdipi))`, params)
    .select('orphan.edipi', 'edipi')
    .addSelect('orphan.unit', 'unit')
    .addSelect('orphan.phone', 'phone')
    .addSelect('action.type', 'action')
    .addSelect('action.expires_on', 'claimedUntil')
    .addSelect('MAX(orphan.timestamp)', 'latestReportDate')
    .addSelect('MIN(orphan.timestamp)', 'earliestReportDate')
    .addSelect('COUNT(*)::INTEGER', 'count')
    .addSelect('orphan.composite_id', 'id')
    .addSelect('roster.unit_id', 'unitId')
    .addSelect('roster.id', 'rosterHistoryId')
    .groupBy('orphan.composite_id')
    .addGroupBy('orphan.edipi')
    .addGroupBy('orphan.unit')
    .addGroupBy('orphan.phone')
    .addGroupBy('action.type')
    .addGroupBy('action.expires_on')
    .addGroupBy('roster.unit_id')
    .addGroupBy('roster.id');
  // .getRawMany<OrphanedRecordResult>();
}

class OrphanedRecordController {
  async getOrphanedRecords(req: ApiRequest<OrgParam>, res: Response) {
    const orphanedRecords = await (getVisibleOrphanedRecordResults(req.appUser!.edipi, req.appOrg!.id).getRawMany<OrphanedRecordResult>());
    res.json(orphanedRecords);
  }

  async addOrphanedRecord(req: ApiRequest<null, OrphanedRecordData>, res: Response) {
    if (!req.body.reportingGroup) {
      throw new BadRequestError('Missing reportingGroup from body.');
    }

    const orphanedRecord = new OrphanedRecord();
    orphanedRecord.documentId = req.body.documentId;
    orphanedRecord.timestamp = new Date(convertDateParam(req.body.timestamp));
    orphanedRecord.edipi = req.body.edipi;
    orphanedRecord.phone = req.body.phone;
    orphanedRecord.unit = req.body.unit;

    const orphanedRecords = await OrphanedRecord.find({
      where: {
        documentId: req.body.documentId,
      },
    });

    if (orphanedRecords.length > 0) {
      res.status(200).json(orphanedRecord);
      return;
    }

    orphanedRecord.org = await Org.findOne({
      where: {
        reportingGroup: req.body.reportingGroup,
      },
    });

    await orphanedRecord.save();
    res.status(201).json(orphanedRecord);
  }

  async deleteOrphanedRecord(req: ApiRequest<OrphanedRecordActionParam>, res: Response) {
    const orphanedRecords = await OrphanedRecord.find({
      where: {
        compositeId: req.params.orphanId,
      },
    });

    if (orphanedRecords.length === 0) {
      throw new BadRequestError(`Unable to locate orphaned record with id: ${req.params.orphanId}`);
    }

    const result = Promise.all(orphanedRecords.map(orphanedRecord => orphanedRecord.softRemove()));
    res.json(result);
  }

  async resolveOrphanedRecord(req: ApiRequest<OrphanedRecordResolveParam, RosterEntryData>, res: Response<OrphanedRecordResolveResponse>) {
    const orphanedRecords = await OrphanedRecord.find({
      where: {
        compositeId: req.params.orphanId,
        deletedOn: null,
      },
    });

    if (orphanedRecords.length === 0) {
      throw new BadRequestError(`Unable to locate orphaned record with id: ${req.params.orphanId}`);
    }
    if (orphanedRecords.length > 1) {
      throw new BadRequestError(`Encountered Multiple Orphaned Records: ${req.params.orphanId}`);
    }

    const orphanedRecord = orphanedRecords[0];
    const resultRecords: OrphanedRecordResolveItem[] = [];
    const documentId = orphanedRecord.documentId;
    let rosterHistory: RosterHistory[] | undefined;

    if (req.body.unit) {
      rosterHistory = await getRosterHistory(orphanedRecord, req.body.unit);
    }

    let newRosterEntry: Roster | undefined;
    if (!rosterHistory?.length) {
      // If the roster entry already exists, backdate the timestamp column
      // of the corresponding  'added' record in he roster history.
      // Otherwise, add the new roster entry and then update the roster history.
      // Add a new roster entry since the orphaned record
      // doesn't correspond to an existing roster entry
      newRosterEntry = await addRosterEntry(req.appOrg!, req.appUserRole!.role, req.body);
      rosterHistory = await getRosterHistory(orphanedRecord, newRosterEntry.unit.id);
    }

    if (!rosterHistory) {
      throw new InternalServerError('Unable to locate RosterHistory record.');
    }

    try {
      await getConnection().transaction(async manager => {
        let timestamp = Math.min(...orphanedRecords.map(x => x.timestamp.getTime()));
        for (const item of rosterHistory!) {

          // Backdate the timestamp to the earliest orphaned record time.
          item.timestamp = new Date(
            Math.min(item.timestamp.getTime(), timestamp),
          );

          // Ensure that two records don't have the same value
          timestamp -= 1;
        }

        // Save the updated timestamp
        await manager.save(rosterHistory);

        // Remove the orphan record entry
        await manager.softRemove(orphanedRecord);

        // Delete any outstanding actions
        await manager
          .createQueryBuilder()
          .delete()
          .from(OrphanedRecordAction)
          .where(`id=:id`, { id: req.params.orphanId })
          .orWhere('expires_on < now()')
          .execute();
      });
    } catch (err) {
      if (newRosterEntry) {
        await newRosterEntry.remove();
      }
      throw err;
    }

    // Request a reingestion of a single document
    const reingestResult = await reingestByDocumentId(documentId);

    // Track the individual ingestion and postgres updated entity
    resultRecords.push({
      ...reingestResult,
      orphanedRecord,
    });

    res.json({
      items: resultRecords,
      ...reingestResult,
    });
  }

  async addOrphanedRecordAction(req: ApiRequest<OrphanedRecordActionParam, OrphanedRecordActionData>, res: Response) {
    if (!req.params.orphanId) {
      throw new BadRequestError(`Param 'id' is required.`);
    }
    if (!req.body.action) {
      throw new BadRequestError(`Expected 'action' in payload.`);
    }

    // Delete any existing actions for this user (or any expired ones)
    await OrphanedRecordAction
      .createQueryBuilder()
      .delete()
      .where(`id=:id`, { id: req.params.orphanId })
      .andWhere('user_edipi=:userEdipi', { userEdipi: req.appUser.edipi })
      .orWhere('expires_on < now()')
      .execute();

    const orphanedRecords = await OrphanedRecord.find({
      where: {
        compositeId: req.params.orphanId,
      },
    });

    if (orphanedRecords.length === 0) {
      throw new BadRequestError(`Unable to locate orphaned record with id: ${req.params.orphanId}`);
    }

    const orphanedRecordAction = new OrphanedRecordAction();
    orphanedRecordAction.id = req.params.orphanId;
    orphanedRecordAction.type = req.body.action;
    orphanedRecordAction.user = req.appUser;

    if (req.body.timeToLiveMs) {
      const date = new Date(Date.now() + req.body.timeToLiveMs);
      date.setTime(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
      orphanedRecordAction.expiresOn = date;
    }

    await orphanedRecordAction.save();
    res.status(201).json(orphanedRecordAction);
  }

  async deleteOrphanedRecordAction(req: ApiRequest<OrphanedRecordDeleteActionData>, res: Response) {
    if (!req.params.orphanId) {
      throw new BadRequestError(`Param 'id' is required.`);
    }
    if (!req.params.action) {
      throw new BadRequestError(`Expected 'action' in payload.`);
    }

    // Delete any existing actions for this user (or any expired ones)
    await OrphanedRecordAction
      .createQueryBuilder()
      .delete()
      .where(new Brackets(qb => {
        qb
          .where(`id=:id`, { id: req.params.orphanId })
          .andWhere('user_edipi=:userEdipi', { userEdipi: req.appUser.edipi })
          .andWhere('type=:action', { action: req.params.action });
      }))
      .orWhere('expires_on < now()')
      .execute();

    res.status(204).send();
  }
}

async function getRosterHistory(orphanedRecord: OrphanedRecord, unit: number) {
  const raw = await getManager().query(`
  SELECT
  "rh"."id" AS "id", "rh"."edipi" AS "edipi",
  "rh"."change_type" AS "change_type",
  "rh"."unit_id" AS "unit_id"
  FROM "roster_history" "rh"
  WHERE "rh"."unit_id" = $1 AND "rh"."timestamp" >= $2
  ORDER BY "rh"."edipi" DESC, "rh"."timestamp" DESC, "rh"."change_type" DESC
  `, [unit, orphanedRecord.timestamp]);

  if (!raw?.length) {
    return undefined;
  }
  return RosterHistory.find({
    where: {
      id: In(raw.map((x: any) => x.id)),
    },
  });
}

export interface OrphanedRecordActionParam extends OrgParam {
  orphanId: string;
}

export interface OrphanedRecordResolveParam extends OrphanedRecordActionParam {
  rosterHistoryId: string;
}

export interface OrphanedRecordResolveItem {
  lambdaInvocationCount: number;
  recordsIngested: number;
  orphanedRecord: Partial<OrphanedRecord>;
}

export interface OrphanedRecordResolveResponse {
  lambdaInvocationCount: number;
  recordsIngested: number;
  items: OrphanedRecordResolveItem[];
}

export interface OrphanedRecordData {
  documentId: string,
  timestamp: number,
  edipi: string,
  phone: string,
  reportingGroup: string,
  unit: string,
}

export interface OrphanedRecordActionData {
  action: ActionType,
  timeToLiveMs?: number
}

export interface OrphanedRecordDeleteActionData extends OrphanedRecordActionParam {
  action: ActionType,
}

export default new OrphanedRecordController();
