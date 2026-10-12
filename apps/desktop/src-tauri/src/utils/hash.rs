use sha2::{Digest, Sha256};
use std::io::{self, Read};

pub(crate) fn sha256_reader(mut reader: impl Read) -> io::Result<String> {
    // digest 0.11 no longer implements io::Write; keep archive hashing bounded in memory.
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = match reader.read(&mut buffer) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if count == 0 {
            return Ok(hex::encode(digest.finalize()));
        }
        digest.update(&buffer[..count]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_known_vectors_and_multiple_buffers() {
        assert_eq!(
            sha256_reader(&b""[..]).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_reader(&b"abc"[..]).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let bytes = vec![0xa5; 150_000];
        assert_eq!(
            sha256_reader(bytes.as_slice()).unwrap(),
            hex::encode(Sha256::digest(&bytes))
        );
    }

    #[test]
    fn retries_interrupted_reads_and_propagates_errors() {
        let mut interrupted = true;
        let mut input = &b"abc"[..];
        struct Reader<F>(F);
        impl<F: FnMut(&mut [u8]) -> io::Result<usize>> Read for Reader<F> {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                (self.0)(buffer)
            }
        }
        let reader = Reader(move |buffer: &mut [u8]| {
            if interrupted {
                interrupted = false;
                Err(io::ErrorKind::Interrupted.into())
            } else {
                input.read(buffer)
            }
        });
        assert_eq!(sha256_reader(reader).unwrap(), hex::encode(Sha256::digest(b"abc")));
        let reader = Reader(|_: &mut [u8]| Err(io::Error::other("read failed")));
        assert_eq!(sha256_reader(reader).unwrap_err().kind(), io::ErrorKind::Other);
    }
}
