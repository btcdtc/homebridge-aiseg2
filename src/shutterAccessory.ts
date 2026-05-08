import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { CheckResult, ShutterOperationResponse, ShutterStatus } from './aiseg2Client';
import { ShutterDevice } from './devices';
import { Aiseg2Platform } from './platform';


export class ShutterAccessory {
  private readonly service: Service;
  private readonly device: ShutterDevice;
  private pendingTargetPosition?: number;
  private pendingDesiredPosition?: number;
  private queuedTargetPosition?: number;
  private positionActionSequence = 0;

  private state = {
    currentPosition: 50,
    targetPosition: 50,
    positionState: 2,
  };

  constructor(
    private readonly platform: Aiseg2Platform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.device = accessory.context.device as ShutterDevice;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Panasonic')
      .setCharacteristic(this.platform.Characteristic.Model, 'AiSEG2 Shutter')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.uuidSeed);

    this.service = this.accessory.getService(this.platform.Service.WindowCovering) ||
      this.accessory.addService(this.platform.Service.WindowCovering);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.platform.formatHomeKitName(this.device.displayName));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentPosition)
      .onGet(() => this.state.currentPosition);
    this.service.getCharacteristic(this.platform.Characteristic.TargetPosition)
      .onSet(this.setTargetPosition.bind(this))
      .onGet(() => this.state.targetPosition)
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: this.platform.client.supportsShutterHalfOpen(this.device) ? 50 : 100,
        validValues: this.platform.client.supportsShutterHalfOpen(this.device) ? [0, 50, 100] : [0, 100],
      });
    this.service.getCharacteristic(this.platform.Characteristic.PositionState)
      .onGet(() => this.state.positionState);
    this.service.getCharacteristic(this.platform.Characteristic.HoldPosition)
      .onSet(this.holdPosition.bind(this));

    this.applyStatus({
      state: this.device.state || '0x31',
      openState: this.device.openState || '',
      condition: this.device.condition || '',
      position: this.positionFromDevice(),
    });

    setInterval(() => {
      this.updateStatus().catch(error => {
        this.platform.log.error(`Failed to update shutter '${this.device.displayName}': ${this.formatError(error)}`);
      });
    }, 30000);
  }

  async updateStatus(force = false): Promise<void> {
    const status = await this.platform.client.getShutterStatus(this.device, force);
    this.applyStatus(status);
  }

  async setTargetPosition(value: CharacteristicValue): Promise<void> {
    const requestedPosition = Math.max(0, Math.min(100, Number(value)));
    if (!Number.isFinite(requestedPosition)) {
      throw new Error(`Invalid shutter target position '${value}'`);
    }

    const targetPosition = this.normalizeTargetPosition(requestedPosition);
    if (this.pendingTargetPosition !== undefined) {
      if (this.pendingTargetPosition !== targetPosition) {
        this.queuedTargetPosition = targetPosition;
        this.applyPendingPosition(this.state.currentPosition, targetPosition);
        this.platform.log.info(
          `${this.device.displayName} position request queued: target=${targetPosition}% ` +
          `while ${this.pendingTargetPosition}% is still pending`,
        );
        return;
      }

      this.applyPendingPosition(this.state.currentPosition, this.pendingTargetPosition);
      this.platform.log.warn(
        `${this.device.displayName} position request ignored while ${this.pendingTargetPosition}% is still pending`,
      );
      return;
    }

    const currentPosition = this.state.currentPosition;
    this.platform.log.info(
      `${this.device.displayName} position request: requested=${requestedPosition}%, ` +
      `target=${targetPosition}%, current=${currentPosition}%`,
    );

    if (targetPosition === currentPosition) {
      this.platform.log.info(`${this.device.displayName} position request ignored: already ${targetPosition}%`);
      return;
    }

    const actionId = this.beginPendingPosition(targetPosition);
    this.applyPendingPosition(currentPosition, targetPosition);

    try {
      const token = await this.platform.client.getShutterControlToken();
      const response = await this.platform.client.changeShutterPosition(this.device, token, targetPosition);
      this.platform.log.info(
        `${this.device.displayName} position request accepted: target=${targetPosition}%, ` +
        `command=${response.command}, page=${response.operationPage}, acceptId=${response.acceptId ?? '-'}`,
      );
      this.monitorPositionAction(actionId, targetPosition, response, token);
      if (this.queuedTargetPosition !== undefined) {
        this.clearPendingPosition(actionId);
        this.runQueuedTargetPosition();
      }
    } catch (error) {
      this.clearPendingPosition(actionId);
      await this.updateStatus(true);
      this.runQueuedTargetPosition();
      throw error;
    }
  }

  private monitorPositionAction(
    actionId: number,
    targetPosition: number,
    response: ShutterOperationResponse,
    token: string,
  ): void {
    void this.confirmAcceptedPositionAction(actionId, targetPosition, response, token).catch(error => {
      this.clearPendingPosition(actionId);
      this.platform.log.error(`${this.device.displayName} post-position refresh failed: ${this.formatError(error)}`);
      this.updateStatus(true).catch(refreshError => {
        this.platform.log.error(`${this.device.displayName} post-position recovery refresh failed: ${this.formatError(refreshError)}`);
      });
    }).finally(() => {
      this.clearPendingPosition(actionId);
      this.runQueuedTargetPosition();
    });
  }

  private async confirmAcceptedPositionAction(
    actionId: number,
    targetPosition: number,
    response: ShutterOperationResponse,
    token: string,
  ): Promise<void> {
    await this.waitForAcceptedChange(response, token);
    if (actionId !== this.positionActionSequence) {
      return;
    }

    if (this.queuedTargetPosition !== undefined) {
      return;
    }

    await this.confirmTargetPosition(actionId, targetPosition);
  }

  async holdPosition(value: CharacteristicValue): Promise<void> {
    if (!value) {
      return;
    }

    this.platform.log.info(`${this.device.displayName} stop request`);
    this.cancelPendingPosition();
    this.queuedTargetPosition = undefined;
    const token = await this.platform.client.getShutterControlToken();
    const response = await this.platform.client.stopShutter(this.device, token);
    this.platform.log.info(
      `${this.device.displayName} stop request accepted: command=${response.command}, ` +
      `page=${response.operationPage}, acceptId=${response.acceptId ?? '-'}`,
    );
    await this.waitForAcceptedChange(response, token);

    this.state.positionState = this.platform.Characteristic.PositionState.STOPPED;
    this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.state.positionState);
    this.updateStatus(true).then(() => {
      this.platform.log.info(`${this.device.displayName} stop state refreshed after action`);
    }).catch(error => {
      this.platform.log.error(`${this.device.displayName} post-stop refresh failed: ${this.formatError(error)}`);
    });
  }

  private applyStatus(status: ShutterStatus): void {
    if (
      this.pendingTargetPosition !== undefined &&
      this.pendingDesiredPosition !== undefined &&
      status.position !== this.pendingDesiredPosition
    ) {
      this.applyPendingPosition(status.position, this.pendingTargetPosition);
      return;
    }

    this.state.currentPosition = status.position;
    this.state.targetPosition = status.position;
    this.state.positionState = this.platform.Characteristic.PositionState.STOPPED;

    this.service.updateCharacteristic(this.platform.Characteristic.CurrentPosition, this.state.currentPosition);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetPosition, this.state.targetPosition);
    this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.state.positionState);
  }

  private positionFromDevice(): number {
    if (this.device.condition === '開' || this.device.openState === '0x41') {
      return 100;
    }

    if (this.device.condition === '閉' || this.device.openState === '0x42') {
      return 0;
    }

    return 50;
  }

  private applyPendingPosition(currentPosition: number, targetPosition: number): void {
    this.state.currentPosition = currentPosition;
    this.state.targetPosition = targetPosition;
    if (targetPosition === currentPosition) {
      this.state.positionState = this.platform.Characteristic.PositionState.STOPPED;
    } else {
      this.state.positionState = targetPosition > currentPosition
        ? this.platform.Characteristic.PositionState.INCREASING
        : this.platform.Characteristic.PositionState.DECREASING;
    }

    this.service.updateCharacteristic(this.platform.Characteristic.CurrentPosition, this.state.currentPosition);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetPosition, this.state.targetPosition);
    this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.state.positionState);
  }

  private async waitForAcceptedChange(response: ShutterOperationResponse, token: string): Promise<void> {
    if (response.result !== undefined && String(response.result) !== CheckResult.OK) {
      throw new Error(`${this.device.displayName} update submission failed: ${JSON.stringify(response)}`);
    }

    const acceptId = Number(response.acceptId);
    if (!Number.isInteger(acceptId)) {
      return;
    }

    for (let count = 0; count < 10; count++) {
      await this.delay(1000);
      const result = await this.platform.client.checkShutterChange(acceptId, this.device, token, response.operationPage);

      if (result === CheckResult.OK) {
        return;
      }

      if (result === CheckResult.Invalid) {
        break;
      }
    }

    throw new Error(`Timed out waiting for '${this.device.displayName}' to update`);
  }

  private async confirmTargetPosition(actionId: number, desiredPosition: number): Promise<void> {
    let lastStatus: ShutterStatus | undefined;

    for (let count = 0; count < 30; count++) {
      if (actionId !== this.positionActionSequence || this.queuedTargetPosition !== undefined) {
        return;
      }

      await this.delay(1000);
      if (actionId !== this.positionActionSequence || this.queuedTargetPosition !== undefined) {
        return;
      }

      const status = await this.platform.client.getShutterStatus(this.device, true);
      if (actionId !== this.positionActionSequence || this.queuedTargetPosition !== undefined) {
        return;
      }

      lastStatus = status;

      if (status.position === desiredPosition) {
        this.applyStatus(status);
        this.platform.log.info(`${this.device.displayName} position confirmed: ${desiredPosition}%`);
        return;
      }

      this.applyPendingPosition(status.position, desiredPosition);
    }

    if (lastStatus) {
      this.applyPendingPosition(lastStatus.position, desiredPosition);
    }
    throw new Error(
      `position confirmation timed out: target=${desiredPosition}%, current=${lastStatus?.position ?? 'unknown'}%`,
    );
  }

  private normalizeTargetPosition(requestedPosition: number): number {
    if (requestedPosition <= 25) {
      return 0;
    }

    if (requestedPosition >= 75) {
      return 100;
    }

    if (this.platform.client.supportsShutterHalfOpen(this.device)) {
      return 50;
    }

    return requestedPosition >= 50 ? 100 : 0;
  }

  private beginPendingPosition(desiredPosition: number): number {
    const actionId = ++this.positionActionSequence;
    this.pendingTargetPosition = desiredPosition;
    this.pendingDesiredPosition = desiredPosition;
    return actionId;
  }

  private clearPendingPosition(actionId: number): void {
    if (actionId === this.positionActionSequence) {
      this.pendingTargetPosition = undefined;
      this.pendingDesiredPosition = undefined;
    }
  }

  private cancelPendingPosition(): void {
    this.positionActionSequence++;
    this.pendingTargetPosition = undefined;
    this.pendingDesiredPosition = undefined;
  }

  private runQueuedTargetPosition(): void {
    if (this.queuedTargetPosition === undefined) {
      return;
    }

    const targetPosition = this.queuedTargetPosition;
    this.queuedTargetPosition = undefined;
    void this.setTargetPosition(targetPosition).catch(error => {
      this.platform.log.error(`${this.device.displayName} queued position request failed: ${this.formatError(error)}`);
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
