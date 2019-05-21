import { Mapper } from "./mapper";

export namespace BufferMapper {
  export function wrap<T>(mapper: Mapper<T, string>): Mapper<T, Buffer> {
    return {
      read: b => mapper.read(b.toString('utf8')),
      write: record => new Buffer(mapper.write(record), 'utf8')
    };
  }
}