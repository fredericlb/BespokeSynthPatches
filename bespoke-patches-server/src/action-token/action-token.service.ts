import { Injectable } from '@nestjs/common';
import { LessThanOrEqual, Repository } from 'typeorm';
import { ActionToken } from './action-token.model';
import { v4 as uuidv4 } from 'uuid';
import { InjectRepository } from '@nestjs/typeorm';

@Injectable()
export class ActionTokenService {
  constructor(
    @InjectRepository(ActionToken)
    private repository: Repository<ActionToken>,
  ) {}

  public async isEnabled(uuid: string): Promise<boolean> {
    return (
      await this.repository.findOneOrFail({
        uuid,
        expirationDate: LessThanOrEqual(new Date()),
      })
    ).enabled;
  }

  public async get(uuid: string): Promise<ActionToken> {
    return await this.repository.findOneOrFail({
      uuid,
      expirationDate: LessThanOrEqual(new Date()),
    });
  }

  public async enableToken(uuid: string, token: string): Promise<ActionToken> {
    const actionToken = await this.repository.findOneOrFail({
      token,
      uuid,
      expirationDate: LessThanOrEqual(new Date()),
    });

    if (actionToken.enabled) {
      return null;
    }

    actionToken.enabled = true;

    await this.repository.save(actionToken);

    return actionToken;
  }

  public async deleteToken(uuid: string): Promise<void> {
    const actionToken = await this.repository.findOneOrFail({
      uuid,
    });

    this.repository.delete(actionToken);
  }

  public async createAndSendMail(): Promise<ActionToken> {
    const expirationDate = new Date();
    expirationDate.setHours(expirationDate.getHours() + 2);
    const actionToken = new ActionToken();
    actionToken.uuid = uuidv4();
    actionToken.token = uuidv4();
    actionToken.expirationDate = expirationDate;

    await this.repository.save(actionToken);

    return actionToken;
  }
}