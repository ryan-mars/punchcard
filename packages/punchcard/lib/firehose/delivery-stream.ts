import AWS = require('aws-sdk');

import iam = require('@aws-cdk/aws-iam');
import core = require('@aws-cdk/core');

import { Assembly, Namespace } from '../core/assembly';
import { Cache } from '../core/cache';
import { Dependency } from '../core/dependency';
import { Resource } from '../core/resource';
import * as Kinesis from '../kinesis';
import { ExecutorService } from '../lambda/executor';
import { Function } from '../lambda/function';
import * as S3 from '../s3';
import { Bucket } from '../s3/bucket';
import { Mapper, RuntimeShape, Shape } from '../shape';
import { Codec } from '../util/codec';
import { Compression } from '../util/compression';
import { Client } from './client';
import { DeliveryStream as DeliveryStreamConstruct, DeliveryStreamDestination, DeliveryStreamType } from './delivery-stream-construct';
import { FirehoseEvent, FirehoseResponse, ValidationResult } from './event';
import { Objects } from './objects';

export type DeliveryStreamProps<S extends Shape<any>> = DeliveryStreamDirectPut<S> | DeliveryStreamFromKinesis<S>;

interface BaseDeliveryStreamProps<S extends Shape<any>> {
  /**
   * Codec with which to read files.
   */
  codec: Codec;

  /**
   * Compression of objects.
   */
  compression: Compression;

  /**
   * Override to tune configuration of the delivery stream transform function.
   */
  executorService?: ExecutorService;

  /**
   * Optional function to validate data being written by Firehose.
   *
   * @default no validation
   */
  validate?: (record: RuntimeShape<S>) => ValidationResult;
}

export interface DeliveryStreamDirectPut<S extends Shape<any>> extends BaseDeliveryStreamProps<S> {
  /**
   * Type of data in the stream.
   */
  shape: S;
}

export interface DeliveryStreamFromKinesis<S extends Shape<any>> extends BaseDeliveryStreamProps<S> {
  /**
   * Kinesis stream to persist in S3.
   */
  stream: Kinesis.Stream<S>;
}

/**
 * A Firehose Delivery Stream writing data to a S3 bucket.
 *
 * It may or may not be consuming from a Kinesis Stream.
 */
export class DeliveryStream<S extends Shape<any>> extends core.Construct implements Dependency<Client<RuntimeShape<S>>>, Resource<DeliveryStreamConstruct> {
  public readonly resource: DeliveryStreamConstruct;
  public readonly shape: S;

  private readonly mapper: Mapper<RuntimeShape<S>, Buffer>;
  private readonly codec: Codec;
  private readonly compression: Compression;
  public readonly processor: Validator<S>;

  constructor(scope: core.Construct, id: string, props: DeliveryStreamProps<S>) {
    super(scope, id);
    const fromStream = props as DeliveryStreamFromKinesis<S>;
    const fromType = props as DeliveryStreamDirectPut<S>;

    if (fromStream.stream) {
      this.shape = fromStream.stream.shape;
    } else {
      this.shape = fromType.shape;
    }
    this.mapper = props.codec.mapper(this.shape);
    this.codec = props.codec;
    this.compression = props.compression;
    this.processor = new Validator(this, 'Validator', {
      mapper: this.mapper,
      validate: props.validate
    });

    if (fromStream.stream) {
      this.resource = new DeliveryStreamConstruct(this, 'DeliveryStream', {
        kinesisStream: fromStream.stream.resource,
        destination: DeliveryStreamDestination.S3,
        type: DeliveryStreamType.KinesisStreamAsSource,
        compression: props.compression.type,
        transformFunction: this.processor.processor
      });
    } else {
      this.resource = new DeliveryStreamConstruct(this, 'DeliveryStream', {
        destination: DeliveryStreamDestination.S3,
        type: DeliveryStreamType.DirectPut,
        compression: fromType.compression.type,
        transformFunction: this.processor.processor
      });
    }
  }

  public objects(): Objects<RuntimeShape<S>, [Dependency<S3.ReadClient>]> {
    const codec = this.codec;
    const compression = this.compression;
    const mapper = this.mapper;
    class Root extends Objects<RuntimeShape<S>, [Dependency<S3.ReadClient>]> {
      public async *run(event: S3.Event, [bucket]: [S3.ReadClient]) {
        for (const record of event.Records) {
          // TODO: parallelism
          // TODO: streaming I/O
          const object = await bucket.getObject({
            Key: record.s3.object.key,
            IfMatch: record.s3.object.eTag
          });
          const buffer = typeof object.Body === 'string' ? Buffer.from(object.Body, 'utf8') : object.Body as Buffer;
          const content = await compression.decompress(buffer);
          for (const entry of codec.split(content)) {
            yield mapper.read(entry);
          }
        }
      }
    }
    return new Root(this, undefined as any, {
      depends: [new Bucket(this.resource.s3Bucket!).readAccess()],
      handle: i => i
    });
  }

  public install(namespace: Namespace, grantable: iam.IGrantable): void {
    namespace.set('deliveryStreamName', this.resource.deliveryStreamName);
    this.resource.grantWrite(grantable);
  }

  public async bootstrap(properties: Assembly, cache: Cache): Promise<Client<RuntimeShape<S>>> {
    return new Client(this,
      properties.get('deliveryStreamName'),
      cache.getOrCreate('aws:firehose', () => new AWS.Firehose()));
  }
}

/**
 * Properties for creating a Validator.
 */
interface ValidatorProps<S extends Shape<any>> {
  mapper: Mapper<RuntimeShape<S>, Buffer>;

  /**
   * Optionally provide an executorService to override the properties
   * of the created Lambda Function.
   *
   * @default executorService with `memorySize: 256` and `timeout: 60`.
   */
  executorService?: ExecutorService;

  /**
   * Additional validation logic to apply to each record.
   *
   * @default no extra validation
   */
  validate?: (record: RuntimeShape<S>) => ValidationResult;
}

/**
 * Validates and formats records flowing from Firehose so that they match the format of a Glue Table.
 */
class Validator<S extends Shape<any>> extends core.Construct {
  public readonly processor: Function<FirehoseEvent, FirehoseResponse, Dependency.None>;

  constructor(scope: core.Construct, id: string, props: ValidatorProps<S>) {
    super(scope, id);
    const executorService = props.executorService || new ExecutorService({
      memorySize: 256,
      timeout: core.Duration.seconds(60)
    });

    this.processor = executorService.spawn(this, 'Processor', {
      depends: Dependency.none,
      handle: async (event: FirehoseEvent) => {
        const response: FirehoseResponse = {records: []};
        event.records.forEach(record => {
          try {
            const data = new Buffer(record.data, 'base64');
            const parsed = props.mapper.read(data);
            let result = ValidationResult.Ok;
            if (props.validate) {
              result = props.validate(parsed);
            }
            response.records.push({
              result: props.validate ? props.validate(parsed) : ValidationResult.Ok,
              recordId: record.recordId,
              data: result === ValidationResult.Ok
                ? props.mapper.write(parsed).toString('base64') // re-format the data if OK
                : record.data // original record if dropped or processing failed
            });
          } catch (err) {
            response.records.push({
              result: ValidationResult.ProcessingFailed,
              recordId: record.recordId,
              data: record.data
            });
          }
        });
        return response;
      }
    });
  }
}