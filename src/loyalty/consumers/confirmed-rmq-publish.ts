import type { ConfirmChannel, Options } from 'amqplib';

// Dedicated channel: at most one publish is in flight. Rabbit sends basic.return
// before its confirm for an unroutable mandatory publication; a positive confirm
// alone is insufficient. A timeout is ambiguous and does not cancel delivery.
export function publishConfirmed(
  channel: ConfirmChannel,
  queue: string,
  body: Buffer,
  properties: Options.Publish,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let returned = false;
    let settled = false;
    const onReturn = () => {
      returned = true;
    };
    const onClose = () => finish(new Error('REPLAY_CHANNEL_CLOSED'));
    const onError = () => finish(new Error('REPLAY_CHANNEL_ERROR'));
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.removeListener('return', onReturn);
      channel.removeListener('close', onClose);
      channel.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error('REPLAY_CONFIRM_TIMEOUT')),
      timeoutMs,
    );
    channel.on('return', onReturn);
    channel.once('close', onClose);
    channel.once('error', onError);
    try {
      channel.sendToQueue(
        queue,
        body,
        { ...properties, persistent: true, mandatory: true },
        (error: unknown) => {
          finish(
            error
              ? new Error('REPLAY_NOT_CONFIRMED')
              : returned
                ? new Error('REPLAY_UNROUTABLE')
                : undefined,
          );
        },
      );
    } catch {
      finish(new Error('REPLAY_PUBLISH_FAILED'));
    }
  });
}
